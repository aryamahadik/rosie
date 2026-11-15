// T-1411 (DL-832; T-1408's handoff): the Workers test pool's outbound tripwire (./outbound.ts; vitest.config.ts's
// Workers pool). Each request here is sent with the global fetch, untouched: workerd's own fetch builds it, sends it to
// the pool's global outbound, the tripwire, and applies its redirect mode to the answer. Every host is under the reserved
// example domain (RFC 2606), the key is made up for this file, and nothing goes anywhere but this isolate.
import { describe, expect, it } from "vitest";

import { TRIPWIRE_STATUS, checkUnclaimed, claimHost, takeUnclaimed, type StandIn } from "./outbound";

/** A host no test in this file claims. */
const UNCLAIMED = "unclaimed.example";
/** The host this file's stand-ins claim. */
const CLAIMED = "claimed.example";
/** A key made up for this file, never a real one. */
const MADE_UP_KEY = `t1411-made-up-key-${crypto.randomUUID()}`;
/** What a request carries besides its host, none of which a tripwire failure may name. */
const PRIVATE_PATH = "/v1/made-up/private-path";
const PRIVATE_QUERY = "made-up-query=t1411";
const PRIVATE_BODY = "A made-up body.";

/** One request as it reached a stand-in. */
interface Arrived {
  readonly url: string;
  readonly method: string;
  readonly key: string | null;
  readonly contentType: string | null;
  readonly body: string;
}

/** A stand-in that keeps each request it gets, then answers it with `answer`. */
function recording(answer: (request: Request) => Response): { arrived: Arrived[]; standIn: StandIn } {
  const arrived: Arrived[] = [];
  const standIn: StandIn = async (request) => {
    arrived.push({
      url: request.url,
      method: request.method,
      key: request.headers.get("x-api-key"),
      contentType: request.headers.get("content-type"),
      body: await request.text(),
    });
    return answer(request);
  };
  return { arrived, standIn };
}

/** A POST carrying the made-up key, a path, a query and a body, to `host`, under `redirect`. */
const privatePost = (host: string, redirect: "manual" | "follow" | "error"): Promise<Response> =>
  fetch(`https://${host}${PRIVATE_PATH}?${PRIVATE_QUERY}`, {
    method: "POST",
    headers: { "x-api-key": MADE_UP_KEY, "content-type": "text/plain" },
    body: PRIVATE_BODY,
    redirect,
  });

/** Everything a tripwire failure must not name. */
const PRIVATE_PARTS = [PRIVATE_PATH, PRIVATE_QUERY, MADE_UP_KEY, "x-api-key", PRIVATE_BODY];

describe("a host no test claimed", () => {
  it("gets the tripwire's failure, naming the host alone, and nothing is sent", async () => {
    const response = await privatePost(UNCLAIMED, "manual");
    const words = await response.text();

    expect(response.status).toBe(TRIPWIRE_STATUS);
    expect(words).toContain(`no test claimed ${UNCLAIMED}, so nothing was sent there`);
    for (const part of PRIVATE_PARTS) expect(words).not.toContain(part);
    // The tripwire kept the host, and only the host; the setup's check would fail this test on it.
    expect(takeUnclaimed()).toEqual([UNCLAIMED]);
  });

  it("fails the test that sent it, naming the host alone (the setup's check after each test)", async () => {
    const response = await privatePost(UNCLAIMED, "follow");
    await response.arrayBuffer();

    let failure: unknown;
    try {
      checkUnclaimed();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const { message } = failure as Error;
    expect(message).toContain(`a request went to ${UNCLAIMED}, which no test claimed`);
    for (const part of PRIVATE_PARTS) expect(message).not.toContain(part);
    // The check emptied the record, so the setup's own check after this test finds nothing.
    expect(takeUnclaimed()).toEqual([]);
  });
});

describe("a claimed host", () => {
  it("gets each request at its stand-in, as workerd's fetch built it, and its answer comes back", async () => {
    const { arrived, standIn } = recording(() => new Response("Stood in.", { status: 200 }));
    claimHost(CLAIMED, standIn);

    const response = await privatePost(CLAIMED, "manual");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Stood in.");
    expect(arrived).toEqual([
      {
        url: `https://${CLAIMED}${PRIVATE_PATH}?${PRIVATE_QUERY}`,
        method: "POST",
        key: MADE_UP_KEY,
        contentType: "text/plain",
        body: PRIVATE_BODY,
      },
    ]);
    expect(takeUnclaimed()).toEqual([]);
  });

  it('is never reached by a request workerd refuses as it builds it (redirect "error", as T-1408 met on staging)', async () => {
    const { arrived, standIn } = recording(() => new Response("Stood in.", { status: 200 }));
    claimHost(CLAIMED, standIn);

    // workerd's fetch refuses the option before it sends anything; a sync throw or a rejection, either is caught here.
    const sending = Promise.resolve().then(() => privatePost(CLAIMED, "error"));

    await expect(sending).rejects.toThrow(TypeError);
    await expect(sending).rejects.toThrow(/Invalid redirect value/u);
    expect(arrived).toEqual([]);
    expect(takeUnclaimed()).toEqual([]);
  });

  it('answers a 3xx that workerd hands back under "manual" and follows under "follow", through the tripwire again', async () => {
    const moved = `https://${CLAIMED}/moved`;
    const here = `https://${CLAIMED}/here`;
    const { arrived, standIn } = recording((request) =>
      request.url === moved ? Response.redirect(here, 302) : new Response("Here.", { status: 200 }),
    );
    claimHost(CLAIMED, standIn);

    const manual = await fetch(moved, { redirect: "manual" });
    await manual.arrayBuffer();
    const followed = await fetch(moved, { redirect: "follow" });

    expect(manual.status).toBe(302);
    expect(manual.headers.get("location")).toBe(here);
    expect(followed.status).toBe(200);
    expect(await followed.text()).toBe("Here.");
    expect(arrived.map((request) => request.url)).toEqual([moved, moved, here]);
    expect(takeUnclaimed()).toEqual([]);
  });

  it("cannot lead a followed redirect off to a host no test claimed: the tripwire answers that one", async () => {
    const { arrived, standIn } = recording(() =>
      Response.redirect(`https://${UNCLAIMED}${PRIVATE_PATH}?${PRIVATE_QUERY}`, 307),
    );
    claimHost(CLAIMED, standIn);

    const response = await privatePost(CLAIMED, "follow");
    const words = await response.text();

    expect(response.status).toBe(TRIPWIRE_STATUS);
    expect(words).toContain(`no test claimed ${UNCLAIMED}`);
    for (const part of PRIVATE_PARTS) expect(words).not.toContain(part);
    expect(arrived.map((request) => request.url)).toEqual([
      `https://${CLAIMED}${PRIVATE_PATH}?${PRIVATE_QUERY}`,
    ]);
    expect(takeUnclaimed()).toEqual([UNCLAIMED]);
  });

  it("is claimed by a bare host alone, once in a test", () => {
    const standIn: StandIn = () => new Response(null, { status: 204 });

    expect(() => {
      claimHost(`https://${CLAIMED}`, standIn);
    }).toThrow(/takes a bare host/u);
    expect(() => {
      claimHost(`${CLAIMED}${PRIVATE_PATH}`, standIn);
    }).toThrow(/takes a bare host/u);
    claimHost(CLAIMED, standIn);
    expect(() => {
      claimHost(CLAIMED.toUpperCase(), standIn);
    }).toThrow(`${CLAIMED} is already claimed in this test`);
  });
});

describe("a claim lasts until its test ends", () => {
  it("claims a host in one test and reaches its stand-in", async () => {
    claimHost(CLAIMED, () => new Response("Stood in.", { status: 200 }));

    const response = await fetch(`https://${CLAIMED}/`);

    expect(await response.text()).toBe("Stood in.");
  });

  it("finds that host unclaimed in the next test", async () => {
    const response = await fetch(`https://${CLAIMED}/`);
    await response.arrayBuffer();

    expect(response.status).toBe(TRIPWIRE_STATUS);
    expect(takeUnclaimed()).toEqual([CLAIMED]);
  });
});
