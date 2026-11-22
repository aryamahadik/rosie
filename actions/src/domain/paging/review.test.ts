// T-635a's proof of review.ts default 30 (K-09 README default 205, DL-1133 Fix 1; MASTER-FLOW-A lines 139 and 149): a
// listing check's done decision writes control (team_check) only on an owner's claim, its summary compared whole with the
// owner's three sentences the listing code exports; on a helper's sentence, or any other summary, controlProven true is
// refused (writeBackNotForKind) with nothing written, and controlProven false is taken as before. The review item reads
// its summary back (StoredReviewItem.summary). Over T-319's in-memory world and K-09's own validator, never a database;
// the items are about Lee Home Services' setup, as K-09's control-team-review.json's is (fixture set v1).

import { describe, expect, it } from "vitest";

import { createToolApiValidator, type CallName, type CallPart } from "../../tool-api";
import {
  HELPER_LISTING_SUMMARIES,
  OWNER_LISTING_SUMMARIES,
  listingSummaryOf,
} from "../../tool-api/journey-1/listing/summary";
import type { PagingPorts } from "./page";
import { NO_TEST_PHONES } from "./ports";
import {
  planDecideReviewItem,
  planOpenReviewItem,
  reviewKeyOf,
  type DecideReviewItemRequest,
  type OpenReviewItemRequest,
} from "./review";
import {
  HOME_SERVICES,
  applyPagingWrites,
  fixture,
  fixturePagingIds,
  pagingWorld,
  readerOn,
  type PagingWorld,
} from "./test-support";

const validator = createToolApiValidator();

function valid(call: CallName, part: CallPart, value: unknown): void {
  expect(validator.check(call, part, value)).toEqual([]);
}

interface Exchange<Request> {
  readonly given: { readonly now: string };
  readonly request: Request;
}

const ITEM = "review-lee-home-listing";

function portsOf(world: PagingWorld, request: OpenReviewItemRequest): PagingPorts {
  return {
    reader: readerOn(world),
    ids: fixturePagingIds({ [`reviewItem|${reviewKeyOf(request)}|`]: ITEM }),
    recipients: { environment: "production", roster: NO_TEST_PHONES },
  };
}

/**
 * A listing check opened with `summary` (control-team-review.json's turn, kind listing_match, its subject the business's
 * setup) and stored in the world, with the decision request control-team-decided.json makes of it, writing back
 * controlProven as given.
 */
async function openedListingCheck(summary: string, controlProven: boolean) {
  const world = pagingWorld();
  const open = fixture("tool-api/fixtures/control-team-review.json") as Exchange<OpenReviewItemRequest>;
  const request: OpenReviewItemRequest = { ...open.request, kind: "listing_match", summary };
  valid("openReviewItem", "request", request);
  const ports = portsOf(world, request);
  const opened = await planOpenReviewItem({ request, now: open.given.now }, ports);
  expect(opened.answer).toMatchObject({ reviewItemId: ITEM, repeated: false });
  applyPagingWrites(world, opened.writes);
  const decide = fixture("tool-api/fixtures/control-team-decided.json") as Exchange<DecideReviewItemRequest>;
  const decision: DecideReviewItemRequest = {
    ...decide.request,
    reviewItemId: ITEM,
    decision: {
      state: "done",
      outcome: "The listing check is done.",
      writeBack: { table: "business_setup", controlProven },
    },
  };
  valid("decideReviewItem", "request", decision);
  return { world, ports, decision, now: decide.given.now };
}

describe("review.ts default 30: a listing check proves control only on an owner's claim (K-09 README default 205)", () => {
  it("stores the item's summary and reads it back with the item (StoredReviewItem.summary)", async () => {
    const summary = listingSummaryOf("helper", "noListing");
    const { world } = await openedListingCheck(summary, false);
    expect(world.reviewItems.get(ITEM)).toMatchObject({ kind: "listing_match", summary, state: "open" });
    expect((await readerOn(world).reviewItem(ITEM))?.summary).toBe(summary);
  });

  it("a done decision on an owner's item writes control proven by the team to business_setup, for each reason", async () => {
    expect(OWNER_LISTING_SUMMARIES).toHaveLength(3);
    for (const summary of OWNER_LISTING_SUMMARIES) {
      const { ports, decision, now } = await openedListingCheck(summary, true);
      const decided = await planDecideReviewItem({ request: decision, now }, ports);
      valid("decideReviewItem", "response", decided.answer);
      expect(decided.answer).toEqual({
        state: "done",
        decidedAt: now,
        written: [
          { table: "review_items", rowId: ITEM, version: 2 },
          { table: "business_setup", rowId: HOME_SERVICES, version: 2 },
        ],
        repeated: false,
      });
      expect(decided.writes.state[1]).toEqual({
        op: "update",
        table: "business_setup",
        key: { business_id: HOME_SERVICES },
        expectVersion: 1,
        set: { control_proven_at: now, control_proven_via: "team_check" },
      });
    }
  });

  it("refuses controlProven true on a helper's item (writeBackNotForKind), with nothing written, for each reason", async () => {
    expect(HELPER_LISTING_SUMMARIES).toHaveLength(3);
    for (const summary of HELPER_LISTING_SUMMARIES) {
      const { world, ports, decision, now } = await openedListingCheck(summary, true);
      const decided = await planDecideReviewItem({ request: decision, now }, ports);
      valid("decideReviewItem", "errors", decided.answer);
      expect(decided.answer).toEqual({ error: "writeBackNotForKind", kind: "listing_match" });
      expect(decided.writes.state).toEqual([]);
      expect(decided.writes.stateEvents).toEqual([]);
      applyPagingWrites(world, decided.writes);
      expect(world.reviewItems.get(ITEM)).toMatchObject({ state: "open", version: 1 });
      expect(world.rows.get(`business_setup/${HOME_SERVICES}`)?.version).toBe(1);
    }
  });

  it("takes controlProven false on a helper's item as before: the item done, nothing written back", async () => {
    for (const summary of HELPER_LISTING_SUMMARIES) {
      const { world, ports, decision, now } = await openedListingCheck(summary, false);
      const decided = await planDecideReviewItem({ request: decision, now }, ports);
      expect(decided.answer).toEqual({
        state: "done",
        decidedAt: now,
        written: [{ table: "review_items", rowId: ITEM, version: 2 }],
        repeated: false,
      });
      expect(decided.writes.state.map((write) => write.table)).toEqual(["review_items"]);
      applyPagingWrites(world, decided.writes);
      expect(world.reviewItems.get(ITEM)).toMatchObject({ state: "done", version: 2 });
      expect(world.rows.get(`business_setup/${HOME_SERVICES}`)?.version).toBe(1);
    }
  });

  it("refuses controlProven true on any summary that is not an owner's sentence whole: never by reading words", async () => {
    const owner = listingSummaryOf("owner", "noListing");
    const others = [
      "A listing check: Claim: owner.",
      `${owner} `,
      owner.replace("Claim: owner.", "Claim: Owner."),
      owner.toLowerCase(),
      `${owner} Claim: helper.`,
    ];
    for (const summary of others) {
      const { ports, decision, now } = await openedListingCheck(summary, true);
      const decided = await planDecideReviewItem({ request: decision, now }, ports);
      expect(decided.answer).toEqual({ error: "writeBackNotForKind", kind: "listing_match" });
      expect(decided.writes.state).toEqual([]);
    }
  });

  it("leaves S1-75's control check as it was: controlProven true writes team_check whatever its summary", async () => {
    const world = pagingWorld();
    const open = fixture("tool-api/fixtures/control-team-review.json") as Exchange<OpenReviewItemRequest>;
    const request: OpenReviewItemRequest = {
      ...open.request,
      summary: listingSummaryOf("helper", "noListing"),
    };
    const ports = portsOf(world, request);
    applyPagingWrites(world, (await planOpenReviewItem({ request, now: open.given.now }, ports)).writes);
    const decide = fixture(
      "tool-api/fixtures/control-team-decided.json",
    ) as Exchange<DecideReviewItemRequest>;
    const decided = await planDecideReviewItem(
      { request: { ...decide.request, reviewItemId: ITEM }, now: decide.given.now },
      ports,
    );
    expect(decided.writes.state[1]).toMatchObject({
      table: "business_setup",
      set: { control_proven_via: "team_check" },
    });
  });
});
