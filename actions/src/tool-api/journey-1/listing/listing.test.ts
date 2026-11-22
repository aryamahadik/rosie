// T-635a's unit proofs (the card's "Proves it with"; K-09 README defaults 200 to 208, as the S1-09 design ruling's card 3
// and DL-1133 list them): S1-09's settler over T-434's Places double, S1-09's read-only writer and S1-76's writer, as the
// commit's walk calls them (the settler once, then S1-09's writer, then S1-76's on "No match, or already listed"), on one
// turn context, over doubles of the K-05 reads, the stop home and T-319's paging world (test-support.ts). The card's
// cases:
//   - "Lee's Barbershop in Springfield, I'm the owner" (and with a curly apostrophe) gives the owner's branch and the
//     read-back row, the business named by the typed name only;
//   - a real-looking name and town gives no match, S1-76's row and one review item with "Claim: owner. Reason: no
//     listing.";
//   - no town, or no details, makes the reading answer "ask" (and the bound settler refuse);
//   - the helper's option with a match gives the helper's branch (no item, no control); with no match S1-76 with "Claim:
//     helper";
//   - a done decision on a helper's listing_match item writes no control (writeBackNotForKind), on an owner's team_check;
//   - a banned word through the optional port gives no match with "Reason: banned word.";
//   - a failed port call gives placesUnavailable with nothing written;
//   - nothing of a candidate is written on any branch.
// And around them: default 202's split and its order, two held candidates, the writer's reads and refusals, and nothing
// logged.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { createPlacesDouble, type PlacesDouble } from "../../../../../adapters/src/places/double";
import type { StateWrite } from "../../../commit";
import type { StepRows } from "../../../commit/walk";
import type { WalkTestRepo } from "../../../commit/walk/test-support";
import {
  noPagingWrites,
  planDecideReviewItem,
  type DecideReviewItemRequest,
  type PagingPorts,
} from "../../../domain/paging";
import {
  applyPagingWrites,
  fixture,
  pagingWorld,
  readerOn,
  type PagingWorld,
} from "../../../domain/paging/test-support";
import { NO_TEST_PHONES, KEYED_PAGING_IDS } from "../../../domain/paging";
import { readsOn, seedWorld, type World } from "../../../homes/stop/test-support";
import { NotBuiltError } from "../../errors";
import { stoppedWorld } from "../kinds/test-support";
import {
  HELPS_RUN_IT,
  ListingNotBuiltError,
  ListingReadError,
  ListingRefusedError,
  NO_MATCH,
  OWNER_MATCHES,
  candidateHolds,
  foldMarks,
  listingReadsOf,
  listingSteps,
  listingSummaryOf,
  readS1_09,
  triesOf,
  type BannedWords,
  type ListingSearch,
  type ListingStepsDeps,
} from "./index";
import {
  DEMO_NAME,
  MADE_UP_NAME,
  MADE_UP_WORDS,
  RULING_WORDS,
  RULING_WORDS_CURLY,
  SAM_BUSINESS,
  SAM_HANDLE,
  SAM_PERSON,
  fakeListingK05,
  s1_09Step,
  s1_09Turn,
  s1_76Step,
  settlerCall,
  writerCall,
  type FakeListing,
  type ListingGiven,
  type S1_09Turn,
} from "./test-support";

/** What a candidate of the double holds that no row may hold (default 204): its name's own word, address, phone, site. */
const CANDIDATE_MARKS = [
  "LLC",
  "88 Elm",
  "Elm St",
  "5555550177",
  "555) 010-0177",
  "example.com",
  "places-demo",
];

/** The business head's version the K-05 double answers (ListingGiven's default). */
const HEAD_VERSION = 3;

interface Harness {
  readonly deps: ListingStepsDeps<WalkTestRepo>;
  readonly places: PlacesDouble;
  readonly k05: FakeListing;
  readonly paging: PagingWorld;
}

/** The paging world with Lee's Barbershop's businesses row and its setup row on file, as the review's reads find them. */
function listingPagingWorld(): PagingWorld {
  const world = pagingWorld();
  world.rows.set(`businesses/${SAM_BUSINESS}`, { version: HEAD_VERSION, businessId: SAM_BUSINESS });
  world.rows.set(`business_setup/${SAM_BUSINESS}`, { version: 1, businessId: SAM_BUSINESS });
  return world;
}

function harness(
  options: {
    places?: ListingSearch;
    banned?: BannedWords<WalkTestRepo>;
    given?: ListingGiven;
    stop?: World | null;
    paging?: boolean;
  } = {},
): Harness {
  const places = createPlacesDouble({ now: () => "2026-10-19T14:08:04Z" });
  const k05 = fakeListingK05(options.given);
  const paging = listingPagingWorld();
  const reader = readerOn(paging);
  const deps: ListingStepsDeps<WalkTestRepo> = {
    places: options.places ?? places,
    ...(options.banned === undefined ? {} : { banned: options.banned }),
    reads: listingReadsOf(k05.k05),
    ...(options.stop === null ? {} : { stop: readsOn(options.stop ?? seedWorld(), null) }),
    ...(options.paging === false ? {} : { paging: { reader: () => reader } }),
  };
  return { deps, places, k05, paging };
}

/** What the walk does with the three: the settler once, S1-09's writer, then S1-76's on "No match, or already listed". */
async function walked(turn: S1_09Turn, deps: ListingStepsDeps<WalkTestRepo>) {
  const steps = listingSteps(deps);
  const branch = await steps.settlers["S1-09"](settlerCall(turn));
  const s1_09 = await steps.writers["S1-09"](writerCall(turn, s1_09Step(), branch));
  const s1_76 =
    branch === NO_MATCH ? await steps.writers["S1-76"](writerCall(turn, s1_76Step(), branch)) : null;
  return { branch, s1_09, s1_76 };
}

/** S1-09's writer's state rows for a business as typed, with the setup row inserted (none on file). */
function s1_09State(name: string): StateWrite[] {
  return [
    {
      op: "update",
      table: "businesses",
      key: { id: SAM_BUSINESS },
      expectVersion: HEAD_VERSION,
      set: { name, display_name: name },
    },
    {
      op: "insert",
      table: "business_setup",
      values: { business_id: SAM_BUSINESS, listing_phone: null, website: null, listing_email: null },
    },
  ];
}

/** A quick reply to Sam's handle under Lee's Barbershop on iMessage, naming its step and line, with no plan. */
function ownerRow(id: string, step: string, lineNo: number) {
  return {
    id,
    recipientHandleId: SAM_HANDLE,
    recipientPersonId: SAM_PERSON,
    businessId: SAM_BUSINESS,
    bookingId: null,
    channel: "imessage",
    sendClass: "quick_reply",
    openQuestionId: null,
    copyOfRowId: null,
    versionsRead: [],
    step,
    lineNo,
  };
}

/** Every row a branch writes, as text, holds nothing of a candidate (default 204). */
function holdsNoCandidate(...rows: (StepRows | null)[]): void {
  const written = JSON.stringify(rows);
  for (const mark of CANDIDATE_MARKS) expect(written).not.toContain(mark);
}

/** The thrown error of a promise that must fail. */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => "answered",
    (error: unknown) => error,
  );
}

/** The review item's insert S1-76's writer gives, its values as K-37 holds them. */
function reviewInsert(rows: StepRows | null): Record<string, unknown> {
  const insert = rows?.state.find((write) => write.op === "insert" && write.table === "review_items");
  if (insert?.op !== "insert") throw new Error("S1-76's writer gives a review item");
  return insert.values;
}

const consoleNames = ["log", "info", "warn", "error", "debug"] as const;
let spies: MockInstance[] = [];

beforeEach(() => {
  spies = consoleNames.map((name) => vi.spyOn(console, name).mockImplementation(() => undefined));
});

afterEach(() => {
  // Nothing logs a name, town, address, phone or the owner's words: nothing logs at all.
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  for (const spy of spies) spy.mockRestore();
});

describe("default 202: the fold, the split and the hold", () => {
  it("folds the four typographic marks and nothing else", () => {
    expect(foldMarks("Lee’s ‘Cuts’ “Best”")).toBe("Lee's 'Cuts' \"Best\"");
    expect(foldMarks("LEE`S  Barbershop")).toBe("LEE`S  Barbershop");
  });

  it("splits in default 202's order: (1) first separator to the next comma, (2) the last, (3) first and last", () => {
    expect(triesOf(RULING_WORDS)).toEqual([
      { name: "Lee's Barbershop", town: "Springfield" },
      { name: "Lee's Barbershop in Springfield", town: "I'm the owner" },
      { name: "Lee's Barbershop", town: "I'm the owner" },
    ]);
    expect(triesOf("Lee's Barbershop, 88 Elm St, Springfield")).toEqual([
      { name: "Lee's Barbershop", town: "88 Elm St" },
      { name: "Lee's Barbershop, 88 Elm St", town: "Springfield" },
      { name: "Lee's Barbershop", town: "Springfield" },
    ]);
    expect(triesOf("Cuts in Style in Springfield.")).toEqual([
      { name: "Cuts", town: "Style in Springfield" },
      { name: "Cuts in Style", town: "Springfield" },
      { name: "Cuts", town: "Springfield" },
    ]);
  });

  it("skips a try whose side holds no letter or that repeats an earlier one; no separator leaves no try", () => {
    expect(triesOf("Lee's Barbershop, Springfield")).toEqual([
      { name: "Lee's Barbershop", town: "Springfield" },
    ]);
    expect(triesOf("Lee's Barbershop IN Springfield")).toEqual([
      { name: "Lee's Barbershop", town: "Springfield" },
    ]);
    expect(triesOf("in Springfield")).toEqual([]);
    expect(triesOf("Lee's Barbershop, 1200")).toEqual([]);
    expect(triesOf("Lee's Barbershop")).toEqual([]);
    // "in" inside a word is no separator.
    expect(triesOf("Inkwell Barbering Springfield")).toEqual([]);
  });

  it("holds a candidate to every typed word, in any order, case and punctuation aside (wordsOf)", () => {
    const candidate = { name: "Lee's Barbershop LLC", address: "88 Elm St, Springfield" };
    expect(candidateHolds(candidate, { name: "Lee's Barbershop", town: "Springfield" })).toBe(true);
    expect(candidateHolds(candidate, { name: "barbershop LEES", town: "springfield" })).toBe(false);
    expect(candidateHolds(candidate, { name: "barbershop LEE'S", town: "springfield" })).toBe(true);
    expect(candidateHolds(candidate, { name: "Lee's Barbershop", town: "Riverton" })).toBe(false);
    expect(candidateHolds(candidate, { name: "Lee's Cuts", town: "Springfield" })).toBe(false);
  });
});

describe("the owner's words with the demo listing: the owner's branch and the read-back, the typed name only", () => {
  for (const [label, words] of [
    ["a straight apostrophe", RULING_WORDS],
    ["an iPhone's curly apostrophe", RULING_WORDS_CURLY],
  ] as const) {
    it(`"Lee's Barbershop in Springfield, I'm the owner" with ${label}`, async () => {
      const run = harness();
      const turn = s1_09Turn(OWNER_MATCHES, words);
      const { branch, s1_09, s1_76 } = await walked(turn, run.deps);
      expect(branch).toBe(OWNER_MATCHES);
      expect(s1_76).toBeNull();
      // One search, try (1), exactly the double's demo request; no later try searched.
      expect(run.places.requests()).toEqual([
        { call: "search", request: { by: "nameAndTown", name: "Lee's Barbershop", town: "Springfield" } },
      ]);
      expect(s1_09).toEqual({
        state: s1_09State(DEMO_NAME),
        stateEvents: [],
        gives: ["business"],
        asks: [],
        messages: [ownerRow("outbox-s1-09-sam-1", "S1-09", 1)],
      });
      holdsNoCandidate(s1_09);
      // The span names the step and how it searched: never the name or the town.
      const [span] = run.places.spans();
      expect(JSON.stringify(span)).not.toContain("Springfield");
      expect(JSON.stringify(span)).toContain("S1-09");
    });
  }

  it("the read-back's own form typed back reaches the demo search on try (3), after two that find nothing", async () => {
    const run = harness();
    const { branch, s1_09 } = await walked(
      s1_09Turn(OWNER_MATCHES, "Lee's Barbershop, 88 Elm St, Springfield"),
      run.deps,
    );
    expect(branch).toBe(OWNER_MATCHES);
    expect(run.places.requests().map((each) => each.request)).toEqual([
      { by: "nameAndTown", name: "Lee's Barbershop", town: "88 Elm St" },
      { by: "nameAndTown", name: "Lee's Barbershop, 88 Elm St", town: "Springfield" },
      { by: "nameAndTown", name: "Lee's Barbershop", town: "Springfield" },
    ]);
    expect(s1_09.state).toEqual(s1_09State(DEMO_NAME));
    holdsNoCandidate(s1_09);
  });

  it("a named 'No match, or already listed' still carries the owner's claim: the lookup alone says it matches", async () => {
    const run = harness();
    const { branch, s1_09 } = await walked(s1_09Turn(NO_MATCH, RULING_WORDS), run.deps);
    expect(branch).toBe(OWNER_MATCHES);
    expect(s1_09.messages).toEqual([ownerRow("outbox-s1-09-sam-1", "S1-09", 1)]);
  });

  it("the stop home's noTexts writes no read-back; the rows are written", async () => {
    const run = harness({ stop: stoppedWorld("2026-10-19T14:00:00Z") });
    const { s1_09 } = await walked(s1_09Turn(OWNER_MATCHES, RULING_WORDS), run.deps);
    expect(s1_09.state).toEqual(s1_09State(DEMO_NAME));
    expect(s1_09.messages).toEqual([]);
  });

  it("a setup row on file is not written; the head is updated at the version read", async () => {
    const run = harness({ given: { setupOnFile: true, headVersion: 7 } });
    const { s1_09 } = await walked(s1_09Turn(OWNER_MATCHES, RULING_WORDS), run.deps);
    expect(s1_09.state).toEqual([
      {
        op: "update",
        table: "businesses",
        key: { id: SAM_BUSINESS },
        expectVersion: 7,
        set: { name: DEMO_NAME, display_name: DEMO_NAME },
      },
    ]);
    // Item 79 under the call's business and person, then the head and the setup row on the call's repo (open gap 193).
    expect(run.k05.asked.map((each) => each.read)).toEqual([
      "readPickedKinds",
      "readTurnState",
      "readTurnState",
    ]);
    expect(run.k05.asked[0]).toEqual({
      read: "readPickedKinds",
      request: { businessId: SAM_BUSINESS, personId: SAM_PERSON },
    });
    const facts = run.k05.asked.flatMap((each) =>
      each.read === "readTurnState" ? each.request.facts.map((fact) => `${fact.table}.${fact.column}`) : [],
    );
    expect(facts).toEqual(["businesses.version", "business_setup.version"]);
  });
});

describe("a real-looking name and town: no match, S1-76's row and one review item", () => {
  it("gives 'No match, or already listed', the typed name, S1-76's row and 'Claim: owner. Reason: no listing.'", async () => {
    const run = harness();
    const turn = s1_09Turn(OWNER_MATCHES, MADE_UP_WORDS);
    const { branch, s1_09, s1_76 } = await walked(turn, run.deps);
    expect(branch).toBe(NO_MATCH);
    expect(s1_09).toEqual({
      state: s1_09State(MADE_UP_NAME),
      stateEvents: [],
      gives: ["business"],
      asks: [],
      messages: [],
    });
    expect(s1_76?.messages).toEqual([ownerRow("outbox-s1-76-sam-1", "S1-76", 0)]);
    expect(s1_76?.gives).toEqual([]);
    expect(s1_76?.state).toHaveLength(1);
    const values = reviewInsert(s1_76);
    expect(values).toEqual({
      id: values.id,
      kind: "listing_match",
      business_id: SAM_BUSINESS,
      subject_table: "businesses",
      subject_row_id: SAM_BUSINESS,
      turn_id: turn.context.turn.id,
      raised_by_person_id: SAM_PERSON,
      summary:
        "A listing check (S1-76): the business's details as sent need a person's check before anything goes live. Claim: owner. Reason: no listing.",
      opened_at: turn.request.now,
      due_at: values.due_at,
      state: "open",
    });
    expect(values.summary).toBe(listingSummaryOf("owner", "noListing"));
    // Keyed by the turn with its kind and subject (review.ts default 18), due within 1 business day in New York.
    expect(values.id).toBe(
      await KEYED_PAGING_IDS.rowId(
        "reviewItem",
        JSON.stringify([turn.request.caller.requestId, "listing_match", "businesses", SAM_BUSINESS]),
      ),
    );
    expect(values.due_at).toBe("2026-10-20T14:05:06Z");
    expect(s1_76?.stateEvents.map((entry) => entry.kind)).toEqual(["review_item.opened"]);
    expect(JSON.stringify(s1_76)).not.toContain(MADE_UP_NAME);
    expect(JSON.stringify(s1_76)).not.toContain("Riverton");
    holdsNoCandidate(s1_09, s1_76);
  });

  it("two held candidates on the deciding try give no match (twoListings): Rosie never guesses which is theirs", async () => {
    const asked: unknown[] = [];
    const twoShops: ListingSearch = {
      search(request) {
        asked.push(request);
        return Promise.resolve({
          result: "found",
          candidates: [
            {
              listingRef: "places-made-up-1",
              name: "Lee's Barbershop LLC",
              address: "88 Elm St, Springfield",
              phone: "+15555550177",
              website: "https://example.com",
            },
            {
              listingRef: "places-made-up-2",
              name: "Lee's Barbershop",
              address: "12 Oak Ave, Springfield",
              phone: null,
              website: null,
            },
          ],
        });
      },
    };
    const run = harness({ places: twoShops });
    const { branch, s1_09, s1_76 } = await walked(s1_09Turn(OWNER_MATCHES, RULING_WORDS), run.deps);
    expect(branch).toBe(NO_MATCH);
    expect(asked).toHaveLength(1);
    expect(s1_09.state).toEqual(s1_09State(DEMO_NAME));
    expect(reviewInsert(s1_76).summary).toBe(listingSummaryOf("owner", "twoListings"));
    holdsNoCandidate(s1_09, s1_76);
    expect(JSON.stringify([s1_09, s1_76])).not.toContain("Oak Ave");
  });

  it("a candidate that does not hold the typed words is dropped: no match after the last try", async () => {
    const run = harness();
    // The double answers its demo search only for that exact request; lower case reaches none.
    const { branch, s1_76 } = await walked(
      s1_09Turn(OWNER_MATCHES, "lee's barbershop in springfield"),
      run.deps,
    );
    expect(branch).toBe(NO_MATCH);
    expect(reviewInsert(s1_76).summary).toBe(listingSummaryOf("owner", "noListing"));
  });
});

describe("no town, or no details: the reading answers 'ask' and the bound settler refuses", () => {
  const cases: [string, string | null, string, "noDetails" | "noTown"][] = [
    ["a claim alone (no business field)", null, "Yes, I'm the owner", "noDetails"],
    ["a bare 1", null, "1", "noDetails"],
    ["details with no letter", "1200", "1200", "noDetails"],
    ["a name with no town", "Lee's Barbershop", "Lee's Barbershop", "noTown"],
  ];
  for (const [label, details, text, reason] of cases) {
    it(`${label}: "ask" (${reason}), no search, nothing written`, async () => {
      const run = harness();
      const turn = s1_09Turn(OWNER_MATCHES, details, text);
      expect(await readS1_09(run.deps, settlerCall(turn))).toEqual({
        outcome: "ask",
        reason,
        claim: "owner",
      });
      const steps = listingSteps(run.deps);
      const refused = await refusal(steps.settlers["S1-09"](settlerCall(turn)));
      expect(refused).toBeInstanceOf(ListingRefusedError);
      expect(refused).toMatchObject({ fault: "listingNeedsDetails", ids: ["S1-09", reason] });
      // A writer handed after an "ask" finds no branch held: notSettled, nothing read.
      const writer = await refusal(steps.writers["S1-09"](writerCall(turn, s1_09Step(), OWNER_MATCHES)));
      expect(writer).toMatchObject({ fault: "notSettled" });
      expect(run.places.requests()).toEqual([]);
      expect(run.k05.asked).toEqual([]);
    });
  }

  it("reads the field's words, never its value or the part's quote", async () => {
    const run = harness();
    const turn = s1_09Turn(OWNER_MATCHES, RULING_WORDS);
    if (turn.part.part.verb !== "choose") throw new Error("the part chooses");
    const [field] = turn.part.part.fields;
    if (field === undefined) throw new Error("the part carries the business field");
    field.value = "biz-lees-barbershop";
    turn.part.part.quote = "Something else, Elsewhere";
    expect(await readS1_09(run.deps, settlerCall(turn))).toMatchObject({
      outcome: "branch",
      branch: OWNER_MATCHES,
    });
  });
});

describe("the helper's claim: never an owner's", () => {
  it("with a match: the helper's branch, the typed name, no read-back, no review item and no control", async () => {
    const run = harness();
    const { branch, s1_09, s1_76 } = await walked(s1_09Turn(HELPS_RUN_IT, RULING_WORDS), run.deps);
    expect(branch).toBe(HELPS_RUN_IT);
    expect(s1_76).toBeNull();
    expect(s1_09).toEqual({
      state: s1_09State(DEMO_NAME),
      stateEvents: [],
      gives: ["business"],
      asks: [],
      messages: [],
    });
    expect(JSON.stringify(s1_09)).not.toContain("control");
    holdsNoCandidate(s1_09);
  });

  it("with no match: S1-76's row and the item's 'Claim: helper.', on which a done decision proves no control", async () => {
    const run = harness();
    const turn = s1_09Turn(HELPS_RUN_IT, MADE_UP_WORDS);
    const { branch, s1_09, s1_76 } = await walked(turn, run.deps);
    expect(branch).toBe(NO_MATCH);
    expect(s1_09.state).toEqual(s1_09State(MADE_UP_NAME));
    expect(s1_76?.messages).toEqual([ownerRow("outbox-s1-76-sam-1", "S1-76", 0)]);
    const values = reviewInsert(s1_76);
    expect(values.summary).toBe(listingSummaryOf("helper", "noListing"));
    expect(String(values.summary)).toContain("Claim: helper.");

    // The team's done decision on that very item (as S1-76's writer gave it) with controlProven true is refused.
    applyPagingWrites(run.paging, {
      ...noPagingWrites("S1-76"),
      state: s1_76?.state ?? [],
      stateEvents: s1_76?.stateEvents ?? [],
    });
    const decided = await decide(run.paging, String(values.id), true);
    expect(decided.answer).toEqual({ error: "writeBackNotForKind", kind: "listing_match" });
    expect(decided.writes.state).toEqual([]);
    const closed = await decide(run.paging, String(values.id), false);
    expect(closed.answer).toMatchObject({ state: "done", written: [{ table: "review_items", version: 2 }] });
    expect(closed.writes.state.map((write) => write.table)).toEqual(["review_items"]);
  });

  it("an owner's item from S1-76's writer: the done decision writes control proven by the team", async () => {
    const run = harness();
    const { s1_76 } = await walked(s1_09Turn(OWNER_MATCHES, MADE_UP_WORDS), run.deps);
    applyPagingWrites(run.paging, {
      ...noPagingWrites("S1-76"),
      state: s1_76?.state ?? [],
      stateEvents: s1_76?.stateEvents ?? [],
    });
    const decided = await decide(run.paging, String(reviewInsert(s1_76).id), true);
    expect(decided.writes.state[1]).toEqual({
      op: "update",
      table: "business_setup",
      key: { business_id: SAM_BUSINESS },
      expectVersion: 1,
      set: { control_proven_at: "2026-10-20T13:00:00Z", control_proven_via: "team_check" },
    });
  });
});

/** Rosie's team decides the item (control-team-decided.json's console call, under Lee's Barbershop), writing back as given. */
async function decide(world: PagingWorld, reviewItemId: string, controlProven: boolean) {
  const exchange = fixture("tool-api/fixtures/control-team-decided.json") as {
    request: DecideReviewItemRequest;
  };
  const request: DecideReviewItemRequest = {
    ...exchange.request,
    caller: { ...exchange.request.caller, businessId: SAM_BUSINESS },
    reviewItemId,
    decision: {
      state: "done",
      outcome: "The listing check is done.",
      writeBack: { table: "business_setup", controlProven },
    },
  };
  const ports: PagingPorts = {
    reader: readerOn(world),
    ids: KEYED_PAGING_IDS,
    recipients: { environment: "production", roster: NO_TEST_PHONES },
  };
  return planDecideReviewItem({ request, now: "2026-10-20T13:00:00Z" }, ports);
}

describe("banned words (default 206): through the optional port, bound nowhere", () => {
  /** A made-up listing whose name carries a word a plug-in might ban (S13-11: "licensed" for unlicensed work). */
  const licensed: ListingSearch = {
    search: () =>
      Promise.resolve({
        result: "found",
        candidates: [
          {
            listingRef: "places-made-up-licensed",
            name: "Lee's Licensed Barbershop",
            address: "88 Elm St, Springfield",
            phone: "+15555550177",
            website: "https://example.com",
          },
        ],
      }),
  };
  const banning = (words: readonly string[]) => {
    const asked: unknown[] = [];
    const banned: BannedWords<WalkTestRepo> = {
      bannedWords(call) {
        asked.push({ businessId: call.businessId, personId: call.personId, handleId: call.handleId });
        return Promise.resolve(words);
      },
    };
    return { banned, asked };
  };

  it("a banned word in the one held candidate: no match, 'Reason: banned word.', the typed name, the word never shown", async () => {
    const { banned, asked } = banning(["licensed"]);
    const run = harness({ places: licensed, banned });
    const { branch, s1_09, s1_76 } = await walked(s1_09Turn(OWNER_MATCHES, RULING_WORDS), run.deps);
    expect(branch).toBe(NO_MATCH);
    expect(asked).toEqual([{ businessId: SAM_BUSINESS, personId: SAM_PERSON, handleId: SAM_HANDLE }]);
    expect(s1_09).toEqual({
      state: s1_09State(DEMO_NAME),
      stateEvents: [],
      gives: ["business"],
      asks: [],
      messages: [],
    });
    expect(reviewInsert(s1_76).summary).toBe(listingSummaryOf("owner", "bannedWord"));
    expect(String(reviewInsert(s1_76).summary)).toContain("Reason: banned word.");
    expect(JSON.stringify([s1_09, s1_76]).toLowerCase()).not.toContain("licensed");
    holdsNoCandidate(s1_09, s1_76);
  });

  it("a list that names no word of the candidate changes nothing; no list, no read", async () => {
    const { banned, asked } = banning(["licensed"]);
    const run = harness({ banned });
    expect((await walked(s1_09Turn(OWNER_MATCHES, RULING_WORDS), run.deps)).branch).toBe(OWNER_MATCHES);
    expect(asked).toHaveLength(1);
    const unbound = harness({ places: licensed });
    expect((await walked(s1_09Turn(OWNER_MATCHES, RULING_WORDS), unbound.deps)).branch).toBe(OWNER_MATCHES);
  });

  it("the words are read only for a held match, and a failed read fails closed", async () => {
    const { banned, asked } = banning(["licensed"]);
    const run = harness({ banned });
    expect((await walked(s1_09Turn(OWNER_MATCHES, MADE_UP_WORDS), run.deps)).branch).toBe(NO_MATCH);
    expect(asked).toEqual([]);
    const failing: BannedWords<WalkTestRepo> = {
      bannedWords: () => Promise.reject(new Error("read failed")),
    };
    const broken = harness({ places: licensed, banned: failing });
    const steps = listingSteps(broken.deps);
    const refused = await refusal(
      steps.settlers["S1-09"](settlerCall(s1_09Turn(OWNER_MATCHES, RULING_WORDS))),
    );
    expect(refused).toEqual(new Error("read failed"));
  });
});

describe("a failed port call: placesUnavailable, nothing written", () => {
  it("K-15 unavailable on the first try: refused, no later try, and a writer handed after finds the refusal", async () => {
    const run = harness();
    run.places.failNext({ error: "unavailable", retryAfterSeconds: null });
    const turn = s1_09Turn(OWNER_MATCHES, "Lee's Barbershop, 88 Elm St, Springfield");
    const steps = listingSteps(run.deps);
    const refused = await refusal(steps.settlers["S1-09"](settlerCall(turn)));
    expect(refused).toBeInstanceOf(ListingRefusedError);
    expect(refused).toMatchObject({ fault: "placesUnavailable", ids: ["S1-09", "unavailable"] });
    expect(run.places.requests()).toHaveLength(1);
    const writer = await refusal(steps.writers["S1-09"](writerCall(turn, s1_09Step(), OWNER_MATCHES)));
    expect(writer).toMatchObject({ fault: "placesUnavailable" });
    expect(run.k05.asked).toEqual([]);
  });

  it("a failure on a later try, rate limiting or a port that throws: each refused placesUnavailable at once", async () => {
    const double = createPlacesDouble();
    let calls = 0;
    const secondFails: ListingSearch = {
      search(request, call) {
        calls += 1;
        if (calls === 2) return Promise.resolve({ error: "rateLimited", retryAfterSeconds: 30 });
        return double.search(request, call);
      },
    };
    const turn = s1_09Turn(OWNER_MATCHES, "Lee's Barbershop, 88 Elm St, Springfield");
    const later = await refusal(
      listingSteps(harness({ places: secondFails }).deps).settlers["S1-09"](settlerCall(turn)),
    );
    expect(later).toMatchObject({ fault: "placesUnavailable", ids: ["S1-09", "rateLimited"] });
    expect(calls).toBe(2);

    const throwing: ListingSearch = { search: () => Promise.reject(new Error("socket hang up")) };
    const thrown = await refusal(
      listingSteps(harness({ places: throwing }).deps).settlers["S1-09"](settlerCall(turn)),
    );
    expect(thrown).toMatchObject({ fault: "placesUnavailable", ids: ["S1-09"] });
    expect(String(thrown)).not.toContain("socket");

    const shapeless: ListingSearch = {
      search: () => Promise.resolve({ result: "maybe" } as unknown as { result: "noMatch" }),
    };
    const odd = await refusal(
      listingSteps(harness({ places: shapeless }).deps).settlers["S1-09"](settlerCall(turn)),
    );
    expect(odd).toMatchObject({ fault: "placesUnavailable" });
  });

  it("a refusal names its fault and the step alone: never the name, the town or a candidate's field", async () => {
    const run = harness();
    run.places.failNext({ error: "unavailable", retryAfterSeconds: null });
    const refused = await refusal(
      listingSteps(run.deps).settlers["S1-09"](settlerCall(s1_09Turn(OWNER_MATCHES, RULING_WORDS))),
    );
    expect(refused).toBeInstanceOf(ListingRefusedError);
    expect((refused as Error).message).not.toContain("Lee");
    expect((refused as Error).message).not.toContain("Springfield");
  });
});

describe("the writers: bound with the settler or not at all, and whose rows", () => {
  it("a writer with no settler run refuses notSettled, nothing read", async () => {
    const run = harness();
    const steps = listingSteps(run.deps);
    const turn = s1_09Turn(OWNER_MATCHES, RULING_WORDS);
    for (const [step, branch] of [
      [s1_09Step(), OWNER_MATCHES],
      [s1_76Step(), NO_MATCH],
    ] as const) {
      const refused = await refusal(
        steps.writers[step.id === "S1-09" ? "S1-09" : "S1-76"](writerCall(turn, step, branch)),
      );
      expect(refused).toMatchObject({ fault: "notSettled" });
    }
    // Another instance's settler reading is not this binding's: the three are bound together.
    await listingSteps(run.deps).settlers["S1-09"](settlerCall(turn));
    const other = await refusal(steps.writers["S1-09"](writerCall(turn, s1_09Step(), OWNER_MATCHES)));
    expect(other).toMatchObject({ fault: "notSettled" });
    expect(run.k05.asked).toEqual([]);
  });

  it("refuses a branch the reading did not settle, a writer at another step, and S1-76 on any branch but no match", async () => {
    const run = harness();
    const steps = listingSteps(run.deps);
    const turn = s1_09Turn(OWNER_MATCHES, RULING_WORDS);
    expect(await steps.settlers["S1-09"](settlerCall(turn))).toBe(OWNER_MATCHES);
    expect(await refusal(steps.writers["S1-09"](writerCall(turn, s1_09Step(), NO_MATCH)))).toMatchObject({
      fault: "branchNotSettled",
    });
    expect(await refusal(steps.writers["S1-76"](writerCall(turn, s1_76Step(), NO_MATCH)))).toMatchObject({
      fault: "branchNotSettled",
    });
    expect(await refusal(steps.writers["S1-09"](writerCall(turn, s1_76Step(), OWNER_MATCHES)))).toMatchObject(
      {
        fault: "wrongStep",
      },
    );
    expect(await refusal(steps.settlers["S1-09"](settlerCall(turn, s1_76Step())))).toMatchObject({
      fault: "wrongStep",
    });
  });

  it("refuses with no company of the caller's person under the call's business (noCompany), nothing written", async () => {
    const run = harness({
      given: {
        companies: [
          {
            id: "company-other",
            ownerPersonId: "person-alex",
            name: "Other",
            businessId: SAM_BUSINESS,
            version: 1,
          },
        ],
      },
    });
    const steps = listingSteps(run.deps);
    const turn = s1_09Turn(OWNER_MATCHES, RULING_WORDS);
    await steps.settlers["S1-09"](settlerCall(turn));
    const refused = await refusal(steps.writers["S1-09"](writerCall(turn, s1_09Step(), OWNER_MATCHES)));
    expect(refused).toMatchObject({ fault: "noCompany", ids: ["S1-09"] });
    expect(run.k05.asked.map((each) => each.read)).toEqual(["readPickedKinds"]);
  });

  it("a K-05 read that fails fails closed, never read as none; a missing head is notFound", async () => {
    const run = harness({ given: { turnState: { error: "transient", sqlstate: "40001" } } });
    const steps = listingSteps(run.deps);
    const turn = s1_09Turn(OWNER_MATCHES, MADE_UP_WORDS);
    await steps.settlers["S1-09"](settlerCall(turn));
    const refused = await refusal(steps.writers["S1-09"](writerCall(turn, s1_09Step(), NO_MATCH)));
    expect(refused).toBeInstanceOf(ListingReadError);
    expect(refused).toMatchObject({ read: "readTurnState", fault: "transient" });
    const missing = harness({
      given: { turnState: { error: "notFound", table: "businesses", rowId: SAM_BUSINESS } },
    });
    const missingSteps = listingSteps(missing.deps);
    await missingSteps.settlers["S1-09"](settlerCall(turn));
    expect(
      await refusal(missingSteps.writers["S1-09"](writerCall(turn, s1_09Step(), NO_MATCH))),
    ).toMatchObject({ read: "readTurnState", fault: "notFound" });
  });

  it("a port left out answers notBuilt before anything is read: the stop reads, the paging reader", async () => {
    const noStop = harness({ stop: null });
    const turn = s1_09Turn(OWNER_MATCHES, RULING_WORDS);
    const steps = listingSteps(noStop.deps);
    await steps.settlers["S1-09"](settlerCall(turn));
    const refused = await refusal(steps.writers["S1-09"](writerCall(turn, s1_09Step(), OWNER_MATCHES)));
    expect(refused).toBeInstanceOf(ListingNotBuiltError);
    expect(refused).toBeInstanceOf(NotBuiltError);
    expect(refused).toMatchObject({ seam: "stopNotWired" });
    expect(noStop.k05.asked).toEqual([]);

    const noPaging = harness({ paging: false });
    const noMatchTurn = s1_09Turn(OWNER_MATCHES, MADE_UP_WORDS);
    const pagingSteps = listingSteps(noPaging.deps);
    await pagingSteps.settlers["S1-09"](settlerCall(noMatchTurn));
    expect(
      await refusal(pagingSteps.writers["S1-76"](writerCall(noMatchTurn, s1_76Step(), NO_MATCH))),
    ).toMatchObject({ seam: "pagingNotWired" });
  });

  it("the review item is keyed by the turn: S1-76's writer run again names the same item, and on file plans none", async () => {
    const run = harness();
    const turn = s1_09Turn(OWNER_MATCHES, MADE_UP_WORDS);
    const first = await walked(turn, run.deps);
    applyPagingWrites(run.paging, {
      ...noPagingWrites("S1-76"),
      state: first.s1_76?.state ?? [],
      stateEvents: first.s1_76?.stateEvents ?? [],
    });
    const again = await walked(turn, run.deps);
    expect(again.s1_76?.state).toEqual([]);
    expect(run.paging.reviewItems.size).toBe(1);
  });

  it("nothing of a candidate, no status and no control on any branch: owner and helper, match and no match", async () => {
    for (const [branch, words] of [
      [OWNER_MATCHES, RULING_WORDS],
      [HELPS_RUN_IT, RULING_WORDS],
      [OWNER_MATCHES, MADE_UP_WORDS],
      [HELPS_RUN_IT, MADE_UP_WORDS],
    ] as const) {
      const run = harness();
      const { s1_09, s1_76 } = await walked(s1_09Turn(branch, words), run.deps);
      holdsNoCandidate(s1_09, s1_76);
      for (const write of s1_09.state) {
        const values = write.op === "insert" ? write.values : write.set;
        expect(Object.keys(values)).not.toContain("status");
        expect(Object.keys(values).some((column) => column.startsWith("control"))).toBe(false);
      }
    }
  });
});
