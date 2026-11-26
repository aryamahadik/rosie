// T-1561: what db/repo's openReviewItemsOf (K-05 v1.24 item 88) checks before any statement. No database: every read
// here is sent through a client that throws the moment it is touched, so a request the call refuses is shown refused
// before any statement (a TypeError naming its field, never its value), and a request it accepts is shown to reach the
// client (the client's own error, never a TypeError). What the read answers is db/repo/open-review-items.int.test.ts's.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openReviewItemsOf, type OpenReviewItemsOfRequest, REVIEW_ITEM_KINDS } from "./open-review-items";
import type { Sql } from "./scope";

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const FIXTURES = new URL("data-access/fixtures/", CONTRACTS);
const SENT = "a statement was sent";
const LEE = "biz-lee-home-services";

/** A client no statement may reach: sending one, or reading anything of it, throws an Error that is no TypeError. */
const untouched = new Proxy(() => undefined, {
  apply() {
    throw new Error(SENT);
  },
  get() {
    throw new Error(SENT);
  },
}) as unknown as Sql;

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const requestOf = (file: string): unknown =>
  (readJson(new URL(file, FIXTURES)) as { request: unknown }).request;

async function thrownBy(request: unknown): Promise<unknown> {
  try {
    await openReviewItemsOf(untouched, request as OpenReviewItemsOfRequest);
  } catch (error) {
    return error;
  }
  return null;
}

describe("openReviewItemsOf before any statement (K-05 v1.24 item 88)", () => {
  it("takes K-05 v1.24's reviewItemKind, the kinds K-37 names, and no other", () => {
    const schema = readJson(new URL("data-access/data-access.v1.24.schema.json", CONTRACTS)) as {
      $defs: { reviewItemKind: { enum: string[] } };
    };
    expect([...REVIEW_ITEM_KINDS].sort()).toEqual([...schema.$defs.reviewItemKind.enum].sort());
  });

  it("sends each fixture's request, and each kind, on to the client", async () => {
    const requests = [
      requestOf("open-review-items-lee-listing-match.json"),
      requestOf("open-review-items-lee-none.json"),
      ...[...REVIEW_ITEM_KINDS].map((kind) => ({ businessId: LEE, kind })),
    ];
    for (const request of requests) {
      const error = await thrownBy(request);
      expect(error).not.toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(SENT);
    }
  });

  it("refuses a request of the wrong shape with a TypeError naming the field, never its value", async () => {
    const business = "businessId is a K-04 business id, a non-empty text";
    const kind = "kind is one of K-37's review item kinds";
    const only = "the request takes only businessId, kind";
    const refused: [unknown, string][] = [
      [null, "the request is an object"],
      [[LEE, "control"], "the request is an object"],
      [{ kind: "control" }, business],
      [{ businessId: "", kind: "control" }, business],
      [{ businessId: 3, kind: "control" }, business],
      [{ businessId: "biz\u0000lee", kind: "control" }, business],
      [{ businessId: LEE }, kind],
      [{ businessId: LEE, kind: "Control" }, kind],
      [{ businessId: LEE, kind: "done" }, kind],
      [{ businessId: LEE, kind: ["control"] }, kind],
      [{ businessId: LEE, kind: "control", summary: true }, only],
      [{ businessId: LEE, kind: "control", state: "done" }, only],
    ];
    for (const [request, message] of refused) {
      const error = await thrownBy(request);
      expect(error, message).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(`openReviewItemsOf: ${message}`);
    }
  });
});
