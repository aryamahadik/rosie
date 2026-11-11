// The typed K-21 client's own tests (T-511): its call list is K-21 v1's, its types are the generated contract types
// (`npm run contracts:types`), and its transport to the page entry speaks the entry's wire form (runtime/src/gateway/
// pages: POST {BASE_PATH}/page-api/<call>, a 200 with the outcome and nothing else). A failure is thrown, never an
// answer, and no error holds anything of the request. The page entry here is a stand-in that answers from the Tool API
// mock; every value is a fixture's placeholder or made up (rule 9).
import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import type * as K21 from "../../../contracts/generated/page-api/page-api.v1";
import { ToolApiMockError, loadToolApiMock } from "../../../contracts/mock/mock.mjs";
import {
  PAGE_API_PATH,
  PAGE_CALLS,
  envelopeOf,
  isPageCall,
  isPageError,
  pagePathOf,
  type ErrorOf,
  type OutcomeOf,
  type PageCall,
  type RequestOf,
  type ResponseOf,
} from "./calls";
import { PageApiError, createPageApiClient, pageEntryTransport, type PageApiTransport } from "./client";
import { mockTransport } from "./test-support";

const CONTRACT = new URL("../../../contracts/page-api/", import.meta.url);
const TRACE_ID = "4f1c2b7a-9d3e-4c5f-8a6b-1e2d3c4b5a69";
const BASE_URL = "https://rosfield.com/test";

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(new URL(file, CONTRACT), "utf8"));
}

interface Fixture {
  call: PageCall;
  given: { environment: "staging" | "production" };
  request: Record<string, unknown>;
  outcome: Record<string, unknown>;
}

const fixture = (file: string): Fixture => readJson(`fixtures/${file}`) as Fixture;

const OPEN_LINK = fixture("open-link-secure-page.json");
const OPEN_LINK_EXPIRED = fixture("open-link-expired.json");
const SIGN_OUT = fixture("sign-out.json");

/** One call, with a request read from a fixture file. */
const send = (transport: PageApiTransport, call: PageCall, request: unknown): Promise<unknown> =>
  createPageApiClient(transport, TRACE_ID).call(call, request as RequestOf<PageCall>);

/** What a failed call rejected with. */
const failureOf = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => null,
    (error: unknown) => error,
  );

describe("the client's calls are K-21 v1's", () => {
  it("lists every call of the schema's callName, in its order", () => {
    const schema = readJson("page-api.v1.schema.json") as { $defs: { callName: { enum: string[] } } };
    expect([...PAGE_CALLS]).toEqual(schema.$defs.callName.enum);
    expect(new Set(PAGE_CALLS).size).toBe(26);
  });

  it("knows a call by its exact spelling only", () => {
    for (const call of PAGE_CALLS) expect(isPageCall(call)).toBe(true);
    for (const name of [
      "openlink",
      "OpenLink",
      "openLink ",
      "",
      "constructor",
      "__proto__",
      "bookingPage",
      7,
      null,
    ])
      expect(isPageCall(name), String(name)).toBe(false);
  });

  it("puts each call at the page entry's path, the contract's name and the call's own", () => {
    expect(PAGE_API_PATH).toBe("/page-api");
    expect(pagePathOf("openLink")).toBe("/page-api/openLink");
    expect(pagePathOf("textHoursOverride")).toBe("/page-api/textHoursOverride");
  });

  it("types each call's request and outcome with the generated contract types", () => {
    expectTypeOf<PageCall>().toEqualTypeOf<K21.PageApiV1["call"]>();
    expectTypeOf<RequestOf<"openLink">>().toEqualTypeOf<K21.OpenLinkExchange["request"]>();
    expectTypeOf<OutcomeOf<"openLink">>().toEqualTypeOf<K21.OpenLinkExchange["outcome"]>();
    expectTypeOf<RequestOf<"signInCheck">>().toEqualTypeOf<K21.SignInCheckExchange["request"]>();
    expectTypeOf<OutcomeOf<"signInCheck">>().toEqualTypeOf<K21.SignInCheckExchange["outcome"]>();
    expectTypeOf<RequestOf<"testPhoneSend">>().toEqualTypeOf<K21.TestPhoneSendExchange["request"]>();
    expectTypeOf<OutcomeOf<"fireNow">>().toEqualTypeOf<K21.FireNowExchange["outcome"]>();
    // An outcome is the call's response or one of its errors, and only an error has `error`.
    expectTypeOf<ResponseOf<"signInStart"> | ErrorOf<"signInStart">>().toEqualTypeOf<
      OutcomeOf<"signInStart">
    >();
    expectTypeOf<ErrorOf<"signInStart">>().toExtend<{ error: string }>();
    expectTypeOf<ResponseOf<"signInStart">>().not.toExtend<{ error: string }>();
    expectTypeOf<ErrorOf<"fireNow">["error"]>().toExtend<string>();
    // The client's method takes a call's own request and gives its own outcome.
    const client = createPageApiClient(mockTransport("staging"), TRACE_ID);
    expectTypeOf(client.call<"signOut">)
      .parameter(1)
      .toEqualTypeOf<RequestOf<"signOut">>();
    expectTypeOf(client.call<"signOut">).returns.resolves.toEqualTypeOf<OutcomeOf<"signOut">>();
  });

  it("builds an envelope the generated envelope types take, under the trace id given", () => {
    const anyPage = envelopeOf(TRACE_ID, {
      requestId: "req-example-0001",
      sessionToken: null,
      linkCode: null,
    });
    expect(anyPage).toEqual({
      requestId: "req-example-0001",
      traceId: TRACE_ID,
      sessionToken: null,
      linkCode: null,
    });
    expectTypeOf(anyPage).toExtend<RequestOf<"signInStart">["page"]>();
    const linkPage = envelopeOf(TRACE_ID, {
      requestId: "req-example-0002",
      sessionToken: null,
      linkCode: "dummy-code-0123456789abcd",
    });
    expectTypeOf(linkPage).toExtend<RequestOf<"openLink">["page"]>();
    expect(linkPage.linkCode).toBe("dummy-code-0123456789abcd");
  });
});

describe("the client over the Tool API mock", () => {
  it("answers a fixture's request with the fixture's outcome, typed as the call's own", async () => {
    const client = createPageApiClient(mockTransport("staging"), TRACE_ID);
    expect(client.traceId).toBe(TRACE_ID);
    const outcome = await client.call("openLink", OPEN_LINK.request as unknown as RequestOf<"openLink">);
    expect(outcome).toEqual(OPEN_LINK.outcome);
    expect(isPageError(outcome)).toBe(false);
    if (!isPageError(outcome)) expectTypeOf(outcome).toEqualTypeOf<ResponseOf<"openLink">>();
  });

  it("answers a call's error as its outcome, told apart by isPageError", async () => {
    const client = createPageApiClient(mockTransport("staging"), TRACE_ID);
    const outcome = await client.call(
      "openLink",
      OPEN_LINK_EXPIRED.request as unknown as RequestOf<"openLink">,
    );
    expect(outcome).toEqual({ error: "linkExpired" });
    expect(isPageError(outcome)).toBe(true);
    if (isPageError(outcome)) expectTypeOf(outcome).toEqualTypeOf<ErrorOf<"openLink">>();
  });

  it("records each call it sent, with the trace id", async () => {
    const transport = mockTransport("staging");
    await send(transport, "signOut", SIGN_OUT.request);
    expect(transport.sent).toEqual([{ call: "signOut", request: SIGN_OUT.request, traceId: TRACE_ID }]);
  });

  it("fails loudly on a request no fixture holds: the mock's own error, never an answer", async () => {
    const changed = { ...SIGN_OUT.request, extra: "dummy-extra-field" };
    const failed = await failureOf(send(mockTransport("staging"), "signOut", changed));
    expect(failed).toBeInstanceOf(ToolApiMockError);
    expect((failed as ToolApiMockError).code).toBe("noFixture");
    expect((failed as ToolApiMockError).call).toBe("signOut");
  });

  it("refuses a name that is not a call of K-21 v1 before sending anything, without repeating the name", async () => {
    const transport = mockTransport("staging");
    const failed = await failureOf(send(transport, "dummy-not-a-call" as PageCall, SIGN_OUT.request));
    expect(failed).toBeInstanceOf(PageApiError);
    expect(failed).toMatchObject({ code: "unknownCall", call: null, status: null });
    expect((failed as PageApiError).message).not.toContain("dummy-not-a-call");
    expect(transport.sent).toEqual([]);
  });

  it.each([null, undefined, "linkExpired", 7, true, ["a"]])(
    "refuses an answer that is no JSON object (%j)",
    async (answer) => {
      const transport: PageApiTransport = { send: () => Promise.resolve(answer) };
      const failed = await failureOf(send(transport, "signOut", SIGN_OUT.request));
      expect(failed).toBeInstanceOf(PageApiError);
      expect(failed).toMatchObject({ code: "noOutcome", call: "signOut", status: null });
    },
  );
});

describe("the transport to the page entry", () => {
  interface Seen {
    method: string;
    url: string;
    contentType: string | null;
    traceId: string | null;
    cookie: string | null;
    body: unknown;
  }

  /**
   * A stand-in for the page entry, in its wire form: a POST to <base>/page-api/<call> with a JSON object gets 200 with
   * the Tool API mock's outcome and the trace id in x-trace-id; any other path gets the Worker's 404 JSON.
   */
  function pageEntry(environment: "staging" | "production"): {
    seen: Seen[];
    send: (request: Request) => Promise<Response>;
  } {
    const mock = loadToolApiMock({ environment });
    const seen: Seen[] = [];
    return {
      seen,
      async send(request) {
        const body: unknown = await request.json();
        const traceId = request.headers.get("x-trace-id");
        seen.push({
          method: request.method,
          url: request.url,
          contentType: request.headers.get("content-type"),
          traceId,
          cookie: request.headers.get("cookie"),
          body,
        });
        const headers = { "content-type": "application/json; charset=utf-8", "x-trace-id": traceId ?? "" };
        const prefix = `${BASE_URL}${PAGE_API_PATH}/`;
        const call = request.url.startsWith(prefix) ? request.url.slice(prefix.length) : "";
        if (request.method !== "POST" || !isPageCall(call))
          return new Response(JSON.stringify({ ok: false, error: "not_found", trace_id: traceId }), {
            status: 404,
            headers,
          });
        return new Response(JSON.stringify(mock.answer("page-api", call, body)), { status: 200, headers });
      },
    };
  }

  it("posts the request as JSON to <baseUrl>/page-api/<call> with the trace id in x-trace-id, and gives the outcome", async () => {
    const entry = pageEntry("staging");
    const transport = pageEntryTransport({ baseUrl: BASE_URL, send: entry.send });
    const outcome = await send(transport, "openLink", OPEN_LINK.request);
    expect(outcome).toEqual(OPEN_LINK.outcome);
    expect(entry.seen).toEqual([
      {
        method: "POST",
        url: "https://rosfield.com/test/page-api/openLink",
        contentType: "application/json",
        traceId: TRACE_ID,
        cookie: null,
        body: OPEN_LINK.request,
      },
    ]);
  });

  it("sends every call of K-21 v1 to its own path", async () => {
    const urls: string[] = [];
    const transport = pageEntryTransport({
      baseUrl: "https://rosfield.com",
      send: (request) => {
        urls.push(request.url);
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    });
    for (const call of PAGE_CALLS) await send(transport, call, {});
    expect(urls).toEqual(PAGE_CALLS.map((call) => `https://rosfield.com/page-api/${call}`));
  });

  it("gives a call's error outcome as the entry sent it, a staging-only call's refusal in production included", async () => {
    const fireNow = fixture("fire-now-in-production.json");
    expect(fireNow.given.environment).toBe("production");
    const transport = pageEntryTransport({ baseUrl: BASE_URL, send: pageEntry("production").send });
    expect(await send(transport, "fireNow", fireNow.request)).toEqual({ error: "stagingOnly" });
  });

  it.each([400, 404, 413, 503])(
    "throws for the edge's own %i, which carries no outcome, with the status and nothing of its body or the request",
    async (status) => {
      const transport = pageEntryTransport({
        baseUrl: BASE_URL,
        send: () =>
          Promise.resolve(
            new Response(JSON.stringify({ ok: false, error: "dummy-edge-words", trace_id: TRACE_ID }), {
              status,
            }),
          ),
      });
      const failed = await failureOf(send(transport, "signOut", SIGN_OUT.request));
      expect(failed).toBeInstanceOf(PageApiError);
      expect(failed).toMatchObject({ code: "refusedAtEdge", call: "signOut", status });
      const message = (failed as PageApiError).message;
      expect(message).toBe(`signOut: the page entry answered ${String(status)}, which carries no outcome`);
      for (const value of ["dummy-edge-words", "placeholder", "req-"]) expect(message).not.toContain(value);
    },
  );

  it("throws for a 200 that is not JSON, or is JSON but no object, keeping none of its words", async () => {
    for (const body of ["dummy words, not JSON", '"dummy-string"', "[1]", "null"]) {
      const transport = pageEntryTransport({
        baseUrl: BASE_URL,
        send: () => Promise.resolve(new Response(body, { status: 200 })),
      });
      const failed = await failureOf(send(transport, "signOut", SIGN_OUT.request));
      expect(failed, body).toBeInstanceOf(PageApiError);
      expect(failed).toMatchObject({ code: "noOutcome", call: "signOut" });
      expect((failed as PageApiError).message).not.toContain("dummy");
    }
  });

  it("lets a failure to reach the entry through as it is", async () => {
    const down = new Error("the page entry could not be reached");
    const transport = pageEntryTransport({ baseUrl: BASE_URL, send: () => Promise.reject(down) });
    expect(await failureOf(send(transport, "signOut", SIGN_OUT.request))).toBe(down);
  });
});
