// T-523's proofs for the test-phone page's send side (C-205; build prompt 9.4 "The test-phone page"; K-21 v1
// test-phone-send.json; K-11 v1 double-signed-webhook.json): test-phone-send.json's request is sent with the chosen test
// phone and the typed text, and the response's trace id shows on the page; with no test phone chosen, send is disabled;
// the page never holds or shows a webhook secret, the signed webhook or the tester's token, since signing happens on the
// server through the Linq double. Beside them: D-017's human test (as test owner 1, text JOIN), the page of each other
// answer K-21 v1 gives, the tester login the page sits behind, and the forms it refuses with nothing sent.
// staging-only.test.ts holds the proof that the page is absent in production (T-522).
//
// The page runs on the shell over the Tool API mock, which answers a frozen fixture's request alone and fails the test
// on any other (C-186), or over answers typed by K-21 v1 where no frozen fixture shows the case. Every value is made up
// or a K-21 fixture's own placeholder (rule 9).
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cookieNames } from "../../../auth/cookies";
import { startHref } from "../../../auth/pages";
import { hiddenFields } from "../../../auth/test-support";
import type { OutcomeOf, RequestOf, ResponseOf } from "../../../client/calls";
import { ROUTE_MODULES } from "../../../routes";
import { readWebConfig } from "../../../shell/config";
import { REFERENCE_LABEL } from "../../../shell/error-pages";
import { escapeHtml } from "../../../shell/frame";
import { routeTable } from "../../../shell/route";
import { TEST_LINK_HOST, TRACE_ID, attributeValues, testVars } from "../../../shell/test-support";
import { REFUSED_STATUS, REFUSED_WORDS } from "../../guard";
import { PARTS_PATH, partsHref } from "../parts/page";
import { PICKER_PATH, pickerHref } from "../picker/page";
import { linksIn } from "../picker/test-support";
import {
  GATEWAY_WORDS,
  PHONE_FIELD,
  REPLY_FIELD,
  SEND_PATH,
  TEST_PHONE_PATH,
  WORDS,
  WORDS_MAX,
  testPhoneHref,
} from "./page";
import {
  SEND,
  SENT,
  inputValue,
  mockSendShell,
  open,
  sendFormOf,
  sendPost,
  sessionOf,
  stubSendShell,
  typedInto,
  wholeForm,
} from "./test-support";

/** The fixture's page envelope: its request id, trace id and session token. */
const PAGE = SEND.request.page;
/** The Linq message the fixture's text replies under. */
const REPLY = SEND.request.threadedReplyTo ?? "";
/** The request id the page gives its next form, after the fixture's. */
const NEXT_ID = "req-dummy-next-0001";
/** K-21 v1's transient answer (K-05 v1 transientError): the database could not run the call; nothing was sent. */
const TRANSIENT: OutcomeOf<"testPhoneSend"> = { error: "transient", sqlstate: "40001" };

describe("test-phone-send.json's request is sent with the chosen test phone and the typed text, and the response's trace id shows on the page", () => {
  it("the page opened for tp-04 posts the fixture's request with what was typed, and shows the answer's trace id", async () => {
    expect(REPLY).not.toBe("");
    const { shell, config, transport, lines } = mockSendShell({
      traceId: PAGE.traceId,
      requestIds: [PAGE.requestId, NEXT_ID],
    });
    // The tester opens the page with the phone chosen, as the picker links to it; opening makes no call.
    const opened = await shell.fetch(
      open(testPhoneHref(config, SEND.request.testPhoneId), sessionOf(config)),
    );
    expect(opened.status).toBe(200);
    const fields = hiddenFields(sendFormOf(await opened.text()));
    expect(fields).toEqual({ requestId: PAGE.requestId, phone: SEND.request.testPhoneId });
    expect(transport.sent).toEqual([]);

    // Types the text and the message it replies under, and sends.
    const response = await shell.fetch(
      sendPost(config, typedInto(fields, { words: SEND.request.words, replyTo: REPLY })),
    );
    expect(transport.sent).toEqual([{ call: "testPhoneSend", request: SEND.request, traceId: PAGE.traceId }]);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-trace-id")).toBe(PAGE.traceId);
    const html = await response.text();

    // The answer's trace id shows, with its event id; the page request's own trace id is not shown in its place.
    expect(html).toContain(`<p>${WORDS.traceLabel}: <code>${SENT.traceId}</code></p>`);
    expect(html).toContain(`<p>${WORDS.eventLabel}: <code>${SENT.eventId}</code></p>`);
    expect(html).not.toContain(PAGE.traceId);
    // With what was sent, as which phone, under which message, and the gateway's answer.
    expect(html).toContain(`<h2>${WORDS.sentHeading}</h2>`);
    expect(html).toContain(`<p>${WORDS.sentAs} <code>${SEND.request.testPhoneId}</code>:</p>`);
    expect(html).toContain(`<blockquote><p>${escapeHtml(SEND.request.words)}</p></blockquote>`);
    expect(html).toContain(`<p>${WORDS.repliedUnder} <code>${REPLY}</code>.</p>`);
    expect(html).toContain(`<p>${escapeHtml(GATEWAY_WORDS[200])}</p>`);
    // And the form is ready for the next text as the same phone, under a new request id.
    const next = sendFormOf(html);
    expect(hiddenFields(next)).toEqual({ requestId: NEXT_ID, phone: SEND.request.testPhoneId });
    expect(next).not.toContain("disabled");

    expect(lines()).toEqual([
      { level: "info", msg: "page", trace_id: PAGE.traceId, route: "testPhone.page", status: 200 },
      { level: "info", msg: "page", trace_id: PAGE.traceId, route: "testPhone.send", status: 200 },
    ]);
  });

  it("takes the message to reply under from the page's address, as a link from the phone's parts may give it", async () => {
    const { shell, config, transport } = mockSendShell({
      traceId: PAGE.traceId,
      requestIds: [PAGE.requestId],
    });
    const address = testPhoneHref(config, SEND.request.testPhoneId, REPLY);
    expect(address).toBe(
      `/test${TEST_PHONE_PATH}?${PHONE_FIELD}=${SEND.request.testPhoneId}&${REPLY_FIELD}=${REPLY}`,
    );
    const page = await (await shell.fetch(open(address, sessionOf(config)))).text();
    expect(inputValue(page, REPLY_FIELD)).toBe(REPLY);
    expect(inputValue(page, PHONE_FIELD)).toBe(SEND.request.testPhoneId);

    const response = await shell.fetch(
      sendPost(
        config,
        typedInto(hiddenFields(sendFormOf(page)), {
          words: SEND.request.words,
          replyTo: inputValue(page, REPLY_FIELD) ?? "",
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(transport.sent.map((sent) => sent.request)).toEqual([SEND.request]);
  });

  it("sends the text as typed: each line break a form sends as CR LF goes as LF, and spaces stay", async () => {
    const { shell, config, sent } = stubSendShell(SENT);
    const response = await shell.fetch(
      sendPost(
        config,
        wholeForm("tp-01", "req-dummy-0001", { words: "  Line one\r\nLine two\rLine three  " }),
      ),
    );
    expect(response.status).toBe(200);
    expect(sent.map((call) => (call.request as RequestOf<"testPhoneSend">).words)).toEqual([
      "  Line one\nLine two\nLine three  ",
    ]);
    expect(await response.text()).toContain(
      "<blockquote><p>  Line one<br>Line two<br>Line three  </p></blockquote>",
    );
  });
});

describe("with no test phone chosen, send is disabled", () => {
  it("the page with no phone named: the send form holds no phone, and its text, reply field and button are disabled", async () => {
    const { shell, config, transport } = mockSendShell();
    const response = await shell.fetch(open(testPhoneHref(config), sessionOf(config)));
    expect(response.status).toBe(200);
    const html = await response.text();
    const form = sendFormOf(html);
    expect(hiddenFields(form)).toEqual({ requestId: "req-made-in-test-1" });
    expect(form).toMatch(/<textarea [^>]* disabled>/);
    expect(form).toMatch(/<input id="replyTo" [^>]* disabled>/);
    expect(form).toContain(`<button disabled>${WORDS.send}</button>`);
    expect(html).toContain(`<p>${escapeHtml(WORDS.noneChosen)}</p>`);
    expect(transport.sent).toEqual([]);
  });

  it("a phone chosen: the same form holds it, nothing in it is disabled, and the button names the phone", async () => {
    const { shell, config } = mockSendShell();
    for (const phone of ["tp-01", "t".repeat(128)]) {
      const html = await (await shell.fetch(open(testPhoneHref(config, phone), sessionOf(config)))).text();
      const form = sendFormOf(html);
      expect(hiddenFields(form).phone).toBe(phone);
      expect(form).not.toContain("disabled");
      expect(form).toContain(`<button>${WORDS.sendAs} ${phone}</button>`);
      expect(html).toContain(`<p>${WORDS.sendingAs} <code>${phone}</code>.</p>`);
      expect(inputValue(html, PHONE_FIELD)).toBe(phone);
    }
  });

  it("a roster id typed with spaces around it is chosen without them", async () => {
    const { shell, config } = mockSendShell();
    const html = await (
      await shell.fetch(open(`/test${TEST_PHONE_PATH}?phone=%20tp-01%20`, sessionOf(config)))
    ).text();
    expect(hiddenFields(sendFormOf(html)).phone).toBe("tp-01");
  });

  it.each([
    { what: "an empty phone", phone: "", status: 200 },
    { what: "spaces alone", phone: "   ", status: 200 },
    { what: "a value with a space inside", phone: "tp 01", status: 400 },
    { what: "a value with a line break inside", phone: "tp-01\ntp-02", status: 400 },
    { what: "a value over 128 characters", phone: "t".repeat(129), status: 400 },
  ])("$what in the address: send stays disabled", async ({ phone, status }) => {
    const { shell, config, transport } = mockSendShell();
    const response = await shell.fetch(
      open(`/test${TEST_PHONE_PATH}?phone=${encodeURIComponent(phone)}`, sessionOf(config)),
    );
    expect(response.status).toBe(status);
    const html = await response.text();
    const form = sendFormOf(html);
    expect(Object.keys(hiddenFields(form))).toEqual(["requestId"]);
    expect(form).toContain(`<button disabled>${WORDS.send}</button>`);
    if (status === 400) expect(html).toContain(`<p role="alert">${escapeHtml(WORDS.badPhone)}</p>`);
    else expect(html).not.toContain('role="alert"');
    expect(transport.sent).toEqual([]);
  });

  it.each([
    { what: "no phone", phone: null, problem: WORDS.noPhone },
    { what: "an empty phone", phone: "", problem: WORDS.noPhone },
    { what: "a phone that is no roster id", phone: "tp 01", problem: WORDS.badPhone },
  ])(
    "a send with $what sends nothing, and the page comes back with send disabled",
    async ({ phone, problem }) => {
      const { shell, config, transport } = mockSendShell();
      const fields: Record<string, string> = { requestId: "req-dummy-0001", words: "JOIN", replyTo: "" };
      if (phone !== null) fields.phone = phone;
      const response = await shell.fetch(sendPost(config, fields));
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain(`<p role="alert">${escapeHtml(problem)}</p>`);
      const form = sendFormOf(html);
      expect(Object.keys(hiddenFields(form))).toEqual(["requestId"]);
      expect(form).toContain(`<button disabled>${WORDS.send}</button>`);
      expect(transport.sent).toEqual([]);
    },
  );
});

/** K-11 v1's signed webhook for the fixture's text: what the Linq double makes on the server, never in the page. */
const DOUBLE_WEBHOOK = (
  JSON.parse(
    readFileSync(
      new URL("../../../../../contracts/port-linq/fixtures/double-signed-webhook.json", import.meta.url),
      "utf8",
    ),
  ) as { outcome: { webhook: { timestamp: string; signature: string; raw: string } } }
).outcome.webhook;

/** Every answer K-21 v1 gives testPhoneSend that no frozen fixture shows, each typed by K-21 v1. */
const OTHER_OUTCOMES: readonly OutcomeOf<"testPhoneSend">[] = [
  { ...SENT, gatewayStatus: 401 },
  { ...SENT, gatewayStatus: 503 },
  { error: "stagingOnly" },
  { error: "signInNeeded" },
  { error: "notTester" },
  { error: "notTestPhone", testPhoneId: "tp-99" },
  TRANSIENT,
];

/** Every page the folder answers with, each with what it is: the views, each answer's page and each refused form. */
async function everyPage(): Promise<{ what: string; response: Response }[]> {
  const pages: { what: string; response: Response }[] = [];
  const { shell, config } = mockSendShell({ traceId: PAGE.traceId, requestIds: [PAGE.requestId] });
  const session = sessionOf(config);
  const whole = wholeForm(SEND.request.testPhoneId, PAGE.requestId, {
    words: SEND.request.words,
    replyTo: REPLY,
  });
  pages.push({ what: "signed out", response: await shell.fetch(open(testPhoneHref(config))) });
  pages.push({ what: "no phone", response: await shell.fetch(open(testPhoneHref(config), session)) });
  pages.push({
    what: "a phone and a reply",
    response: await shell.fetch(open(testPhoneHref(config, SEND.request.testPhoneId, REPLY), session)),
  });
  pages.push({
    what: "a bad phone",
    response: await shell.fetch(open(`/test${TEST_PHONE_PATH}?phone=tp%2001`, session)),
  });
  pages.push({ what: "sent", response: await shell.fetch(sendPost(config, whole)) });
  pages.push({ what: "no session", response: await shell.fetch(sendPost(config, whole, {})) });
  for (const typed of [
    { words: "" },
    { words: "x".repeat(WORDS_MAX + 1) },
    { words: "JOIN", replyTo: "a b" },
  ])
    pages.push({
      what: `refused ${JSON.stringify(typed).slice(0, 40)}`,
      response: await shell.fetch(sendPost(config, wholeForm("tp-04", "req-dummy-0001", typed))),
    });
  for (const outcome of OTHER_OUTCOMES) {
    const stub = stubSendShell(outcome);
    pages.push({
      what: JSON.stringify(outcome),
      response: await stub.shell.fetch(sendPost(stub.config, whole)),
    });
  }
  return pages;
}

describe("the page never holds or shows a webhook secret: signing happens on the server through the Linq double", () => {
  it("the call carries K-21 v1's request alone: the page envelope, the roster id, the text and the reply", async () => {
    const { shell, config, transport } = mockSendShell({ traceId: PAGE.traceId });
    await shell.fetch(
      sendPost(
        config,
        wholeForm(SEND.request.testPhoneId, PAGE.requestId, { words: SEND.request.words, replyTo: REPLY }),
      ),
    );
    expect(transport.sent).toHaveLength(1);
    const request = transport.sent[0]?.request as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(["page", "testPhoneId", "threadedReplyTo", "words"]);
    expect(Object.keys(request.page as object).sort()).toEqual([
      "linkCode",
      "requestId",
      "sessionToken",
      "traceId",
    ]);
    expect(request).toEqual(SEND.request);
    // Nothing of the signed webhook goes with it: the server builds the event and the double signs it.
    const sent = JSON.stringify(request);
    for (const part of [DOUBLE_WEBHOOK.timestamp, DOUBLE_WEBHOOK.signature, DOUBLE_WEBHOOK.raw])
      expect(sent).not.toContain(part);
  });

  it("no page it answers holds the signed webhook, a secret or the session token, and none sets a cookie", async () => {
    const pages = await everyPage();
    expect(pages.length).toBeGreaterThan(14);
    expect([...new Set(pages.map((page) => page.response.status))].sort((a, b) => a - b)).toEqual([
      200, 400, 403, 502, 503,
    ]);
    for (const { what, response } of pages) {
      expect(response.headers.has("set-cookie"), what).toBe(false);
      const html = await response.text();
      for (const held of [
        PAGE.sessionToken,
        DOUBLE_WEBHOOK.timestamp,
        DOUBLE_WEBHOOK.signature,
        DOUBLE_WEBHOOK.raw,
        "whsec_",
        "webhook-signature",
      ])
        expect(html, what).not.toContain(held);
      // A form holds the page's own request id and the chosen phone, the text and the reply, and nothing else.
      for (const control of html.match(/<(?:input|textarea|select|button)\b[^>]*>/g) ?? [])
        for (const name of attributeValues(control, "name"))
          expect(["requestId", PHONE_FIELD, "words", REPLY_FIELD], what).toContain(name);
      for (const [name, value] of Object.entries(hiddenFields(html)))
        if (name === PHONE_FIELD) expect(value, what).toBe(SEND.request.testPhoneId);
        else expect(value, what).toMatch(/^req-[a-z-]+[0-9]+$/);
    }
  });

  it("its code reaches no signer and no secret: the folder's own files import only the web app's shell, client, sign-in and staging guard", () => {
    const folder = fileURLToPath(new URL("./", import.meta.url));
    const shipped = readdirSync(folder)
      .filter((name) => !name.endsWith(".test.ts") && name !== "test-support.ts")
      .sort();
    expect(shipped).toEqual(["page.ts", "routes.ts", "send.ts"]);
    const allowed = [
      "../../../auth/consoles",
      "../../../auth/cookies",
      "../../../auth/pages",
      "../../../client/calls",
      "../../../shell/config",
      "../../../shell/frame",
      "../../../shell/route",
      "../../guard",
      "./page",
      "./send",
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

describe("D-017's human test: on the staging test-phone page, as test owner 1, text JOIN", () => {
  it("sends JOIN as tp-01, a plain text, and shows the answer's trace id", async () => {
    const answer = {
      result: "sent",
      eventId: "evt-dummy-0100-0001",
      traceId: "trace-dummy-join-0001",
      gatewayStatus: 200,
    } satisfies ResponseOf<"testPhoneSend">;
    const { shell, config, sent } = stubSendShell(answer, {
      requestIds: ["req-dummy-join-0001", "req-dummy-join-0002"],
    });
    const page = await (await shell.fetch(open(testPhoneHref(config, "tp-01"), sessionOf(config)))).text();
    const response = await shell.fetch(
      sendPost(config, typedInto(hiddenFields(sendFormOf(page)), { words: "JOIN" })),
    );
    expect(sent).toEqual([
      {
        call: "testPhoneSend",
        traceId: TRACE_ID,
        request: {
          page: {
            requestId: "req-dummy-join-0001",
            traceId: TRACE_ID,
            sessionToken: PAGE.sessionToken,
            linkCode: null,
          },
          testPhoneId: "tp-01",
          words: "JOIN",
          threadedReplyTo: null,
        },
      },
    ]);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`<p>${WORDS.traceLabel}: <code>trace-dummy-join-0001</code></p>`);
    expect(html).toContain("<blockquote><p>JOIN</p></blockquote>");
    expect(html).not.toContain(WORDS.repliedUnder);
    expect(hiddenFields(sendFormOf(html))).toEqual({ requestId: "req-dummy-join-0002", phone: "tp-01" });
  });
});

describe("each other answer K-21 v1 gives testPhoneSend has its page", () => {
  const TYPED = { words: "Is there a spot?\nSaturday?", replyTo: "linq-msg-dummy-0001" };
  const FORM = wholeForm("tp-04", "req-dummy-0001", TYPED);

  it.each([401, 503] as const)(
    "sent, the gateway answering %s: not taken, said plainly, with the trace id, and the page's status 502",
    async (gatewayStatus) => {
      const { shell, config } = stubSendShell({ ...SENT, gatewayStatus });
      const response = await shell.fetch(sendPost(config, FORM));
      expect(response.status).toBe(502);
      const html = await response.text();
      expect(html).toContain(`<h2>${WORDS.notTakenHeading}</h2>`);
      expect(html).not.toContain(`<h2>${WORDS.sentHeading}</h2>`);
      expect(html).toContain(`<p>${escapeHtml(GATEWAY_WORDS[gatewayStatus])}</p>`);
      expect(html).toContain(`<p>${WORDS.traceLabel}: <code>${SENT.traceId}</code></p>`);
    },
  );

  it("stagingOnly (the server is not on staging): the staging-only guard's refused page, never a send", async () => {
    const { shell, config } = stubSendShell({ error: "stagingOnly" });
    const response = await shell.fetch(sendPost(config, FORM));
    expect(response.status).toBe(REFUSED_STATUS);
    const html = await response.text();
    expect(html).toContain(`<h1>${REFUSED_WORDS.title}</h1>`);
    for (const line of REFUSED_WORDS.lines) expect(html).toContain(`<p>${escapeHtml(line)}</p>`);
    expect(html).toContain(`<p>${REFERENCE_LABEL}: <code>${TRACE_ID}</code></p>`);
    expect(html).not.toContain(WORDS.traceLabel);
  });

  it("signInNeeded: the page asks for sign-in first, and says nothing was sent", async () => {
    const { shell, config } = stubSendShell({ error: "signInNeeded" });
    const response = await shell.fetch(sendPost(config, FORM));
    expect(response.status).toBe(403);
    const html = await response.text();
    expect(html).toContain(`<h1>${WORDS.signInTitle}</h1>`);
    expect(html).toContain(`<p>${WORDS.nothingSent}</p>`);
    expect(html).toContain(`<p><a href="${startHref(config, null)}">${WORDS.signIn}</a></p>`);
    expect(html).not.toContain("<form");
  });

  it("notTester: the account is neither a tester nor on Rosie's team, and nothing was sent", async () => {
    const { shell, config } = stubSendShell({ error: "notTester" });
    const response = await shell.fetch(sendPost(config, FORM));
    expect(response.status).toBe(403);
    const html = await response.text();
    expect(html).toContain(`<h1>${WORDS.notTesterTitle}</h1>`);
    expect(html).toContain(`<p>${escapeHtml(WORDS.notTesterLine)}</p>`);
    expect(html).toContain(`<p>${WORDS.nothingSent}</p>`);
    expect(html).not.toContain("<form");
  });

  it("notTestPhone: the page names the roster id, and send is disabled until another phone is chosen", async () => {
    const { shell, config } = stubSendShell({ error: "notTestPhone", testPhoneId: "tp-99" });
    const response = await shell.fetch(sendPost(config, wholeForm("tp-99", "req-dummy-0001", TYPED)));
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain(`<p role="alert">tp-99 ${escapeHtml(WORDS.notOnRoster)}</p>`);
    const form = sendFormOf(html);
    expect(Object.keys(hiddenFields(form))).toEqual(["requestId"]);
    expect(form).toContain(`<button disabled>${WORDS.send}</button>`);
  });

  it("transient: nothing was sent; the form again for the same phone, the text and reply kept, under a new request id", async () => {
    const { shell, config } = stubSendShell(TRANSIENT, { requestIds: ["req-dummy-again-0001"] });
    const response = await shell.fetch(sendPost(config, FORM));
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain(`<p role="alert">${escapeHtml(WORDS.tryAgain)}</p>`);
    const form = sendFormOf(html);
    expect(hiddenFields(form)).toEqual({ requestId: "req-dummy-again-0001", phone: "tp-04" });
    expect(form).toContain(`>\n${escapeHtml(TYPED.words)}</textarea>`);
    expect(inputValue(form, REPLY_FIELD)).toBe(TYPED.replyTo);
    expect(form).not.toContain("disabled");
  });
});

describe("the page sits behind the tester login (T-520)", () => {
  it("opened with no session cookie: the page asks for sign-in, holds no form and makes no call", async () => {
    const { shell, config, transport } = mockSendShell();
    for (const address of [testPhoneHref(config), testPhoneHref(config, "tp-01")]) {
      const response = await shell.fetch(open(address));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(`<h1>${WORDS.signInTitle}</h1>`);
      expect(html).toContain(`<p><a href="${startHref(config, null)}">${WORDS.signIn}</a></p>`);
      expect(html).not.toContain("<form");
      expect(html).not.toContain(WORDS.nothingSent);
    }
    expect(transport.sent).toEqual([]);
  });

  it("a send with no session cookie, one that does not read as a token, or production's own cookie: nothing is sent", async () => {
    const { shell, config, transport } = mockSendShell();
    const production = readWebConfig(testVars("production"));
    expect(cookieNames(production).session).not.toBe(cookieNames(config).session);
    for (const cookie of [{}, sessionOf(config, "dummy-short"), sessionOf(production)]) {
      const response = await shell.fetch(
        sendPost(config, wholeForm("tp-01", "req-dummy-0001", { words: "JOIN" }), cookie),
      );
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain(`<h1>${WORDS.signInTitle}</h1>`);
      expect(html).toContain(`<p>${WORDS.nothingSent}</p>`);
    }
    expect(transport.sent).toEqual([]);
  });
});

describe("a form the page cannot send is refused, with nothing sent and what was typed kept", () => {
  const PHONE = "tp-01";

  it.each([
    { what: "no request id", fields: { phone: PHONE, words: "JOIN" }, problem: WORDS.badForm },
    {
      what: "a request id that is no id",
      fields: { requestId: "req 01", phone: PHONE, words: "JOIN" },
      problem: WORDS.badForm,
    },
    { what: "no text", fields: wholeForm(PHONE, "req-dummy-0001", {}), problem: WORDS.noWords },
    {
      what: "spaces and line breaks alone",
      fields: wholeForm(PHONE, "req-dummy-0001", { words: " \r\n\t " }),
      problem: WORDS.noWords,
    },
    {
      what: "a text over 10,000 characters",
      fields: wholeForm(PHONE, "req-dummy-0001", { words: "x".repeat(WORDS_MAX + 1) }),
      problem: WORDS.tooLong,
    },
    {
      what: "a reply id with a space inside",
      fields: wholeForm(PHONE, "req-dummy-0001", { words: "JOIN", replyTo: "linq msg" }),
      problem: WORDS.badReply,
    },
    {
      what: "a reply id over 256 characters",
      fields: wholeForm(PHONE, "req-dummy-0001", { words: "JOIN", replyTo: "m".repeat(257) }),
      problem: WORDS.badReply,
    },
  ])("$what: 400, the problem said, the page for the same phone", async ({ fields, problem }) => {
    const { shell, config, transport } = mockSendShell();
    const response = await shell.fetch(sendPost(config, fields));
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain(`<p role="alert">${escapeHtml(problem)}</p>`);
    expect(hiddenFields(sendFormOf(html)).phone).toBe(PHONE);
    if (problem === WORDS.badReply) expect(sendFormOf(html)).toContain(">\nJOIN</textarea>");
    expect(transport.sent).toEqual([]);
  });

  it("a body that is no form: 400, nothing sent", async () => {
    const { shell, config, transport } = mockSendShell();
    const response = await shell.fetch(
      new Request(`https://${TEST_LINK_HOST}${config.basePath}${SEND_PATH}`, {
        method: "POST",
        headers: {
          origin: `https://${TEST_LINK_HOST}`,
          "content-type": "application/json",
          cookie: `${cookieNames(config).session}=${PAGE.sessionToken}`,
        },
        body: JSON.stringify(wholeForm(PHONE, "req-dummy-0001", { words: "JOIN" })),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(`<p role="alert">${escapeHtml(WORDS.badForm)}</p>`);
    expect(transport.sent).toEqual([]);
  });

  it("a text of exactly 10,000 characters is sent", async () => {
    const { shell, config, sent } = stubSendShell(SENT);
    const words = "x".repeat(WORDS_MAX);
    const response = await shell.fetch(sendPost(config, wholeForm(PHONE, "req-dummy-0001", { words })));
    expect(response.status).toBe(200);
    expect(sent.map((call) => (call.request as RequestOf<"testPhoneSend">).words)).toEqual([words]);
  });
});

describe("every value from the request or the answer is escaped", () => {
  it("the roster id, the text, the reply id and the answer's ids show as text, never as markup", async () => {
    const answer = { ...SENT, traceId: 'trace-<b>"dummy"</b>', eventId: "evt-<i>&dummy" };
    const { shell, config } = stubSendShell(answer);
    const response = await shell.fetch(
      sendPost(
        config,
        wholeForm("tp-<b>", "req-dummy-0001", {
          words: '<script>alert("dummy")</script> & more',
          replyTo: "linq-<u>dummy",
        }),
      ),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    for (const markup of ["<script", "<b>", "<i>", "<u>"]) expect(html).not.toContain(markup);
    expect(html).toContain("&lt;script&gt;alert(&quot;dummy&quot;)&lt;/script&gt; &amp; more");
    expect(html).toContain("<code>trace-&lt;b&gt;&quot;dummy&quot;&lt;/b&gt;</code>");
    expect(html).toContain("<code>evt-&lt;i&gt;&amp;dummy</code>");
    expect(html).toContain("<code>linq-&lt;u&gt;dummy</code>");
    expect(hiddenFields(sendFormOf(html)).phone).toBe("tp-<b>");
  });
});

describe("after a send, the page links to this phone's texts and to the picker (T-524; DL-807)", () => {
  it("See this phone's texts opens the thread view for the same phone and Choose another phone opens the picker, each at a route web/src/routes.ts lists; the page before a send has neither", async () => {
    const table = routeTable(ROUTE_MODULES.flatMap((module) => module.routes));
    expect(table.match(PARTS_PATH)?.route.label).toBe("testPhone.parts");
    expect(table.match(PICKER_PATH)?.route.label).toBe("testPhone.phones");
    for (const phone of ["tp-04", 'tp-<b>&"0?#']) {
      const { shell, config } = stubSendShell(SENT);
      const opened = await (await shell.fetch(open(testPhoneHref(config, phone), sessionOf(config)))).text();
      const before = linksIn(opened).map((link) => link.words);
      expect(before, phone).not.toContain(WORDS.seeTexts);
      expect(before, phone).not.toContain(WORDS.choosePhone);

      const response = await shell.fetch(
        sendPost(config, wholeForm(phone, "req-dummy-0001", { words: "JOIN" })),
      );
      expect(response.status, phone).toBe(200);
      const links = linksIn(await response.text());
      expect(links, phone).toContainEqual({ href: partsHref(config, phone), words: WORDS.seeTexts });
      expect(links, phone).toContainEqual({ href: pickerHref(config), words: WORDS.choosePhone });
    }
  });
});
