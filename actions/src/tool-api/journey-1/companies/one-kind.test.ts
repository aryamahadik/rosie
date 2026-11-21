// T-1492: the one-kind path (K-09 README default 199 item (4), default 185; DL-1033 ruling 7, DL-1049; rule-onekind.json
// card 7). Proved through T-1491's walk on its test graph (bundle v1's flow A with S1-08 and S1-09), with the real step
// writers H1a binds around it: T-633's S1-02, S1-03 and S1-74 writers over their K-05 double, T-634's `kinds` wrapper and
// S1-11 writer over bundle v1's trade overlays, and a stand-in for S1-08's writer (T-1482's). The code under test is this
// folder's wrapper and settler, never a double: only the K-05 reads (items 79 and 72, readTurnState's catalog facts) are
// doubles, as db/repo answers them. Where a case needs S1-02's rows in a shape T-633's writer never gives (a malformed
// pick, another person's, two picks of one kind, none inserted), a stand-in S1-02 writer gives them.

import { describe, expect, it } from "vitest";

import { buildCommitRequest } from "../../../commit/build";
import { contractChecks, eventLogRowsOf } from "../../../commit/test-support";
import type { StateWrite } from "../../../commit/types";
import {
  createWritesOf,
  flowGraphOf,
  type ButtonsSettlerCall,
  type StepRows,
  type StepWriter,
} from "../../../commit/walk";
import {
  NOTHING_OPEN,
  SAM,
  bundleV1Bundles,
  decidedOf,
  flowAWithPlan,
  questionsOver,
  tellingWriter,
  type WalkTestRepo,
} from "../../../commit/walk/test-support";
import { fixture } from "../../test-support";
import type { CatalogKind } from "../../../domain/kind-matcher";
import {
  fakeK05,
  earlierPick,
  GIFT_CARDS,
  PACK_HIKES,
  seededCatalog,
  turnWithWords,
  writerDeps,
} from "../kinds/test-support";
import { kindsWriters } from "../kinds";
import { createPlugInWriters, PF_TEXT_KEYS } from "../plug-ins";
import { tradesOverV1 } from "../plug-ins/test-support";
import {
  COMPANIES,
  CompaniesReadError,
  CompaniesRefusedError,
  PROTECTIVE_FACTS,
  companiesReadsOf,
  companyKindInsert,
  companyKindOnFile,
  createOneKind,
  draftedDefaults,
  turnCompanyOf,
  type CompaniesFault,
  type CompaniesReadFault,
} from "./index";
import {
  SAM_BUSINESS,
  SAM_COMPANY,
  SAM_HANDLE,
  SAM_PERSON,
  catalogDefaults,
  fakeCompaniesK05,
  pickOnFile,
  samCompanies,
  seedCompanyKinds,
  type CompaniesGiven,
} from "./test-support";

const ALL = "c-01";
const ONE_NEW = "c-02";
const NOT_A_SERVICE = "c-03";

/** What one walk is given, beyond the K-05 doubles' answers. */
interface Given extends CompaniesGiven {
  /** Bind the one-kind path (the wrapper on S1-02 and the settler at S1-04). Default: true. */
  readonly oneKind?: boolean;
  /** Bind the settler but leave S1-02's writer unwrapped. */
  readonly noWrap?: boolean;
  /** A stand-in for T-633's S1-02 writer, in its place under the wrapper. */
  readonly s1_02?: StepWriter<WalkTestRepo>;
  /** A change to S1-02's rows made outside the one-kind wrapper (inside T-634's), as another wrapper might. */
  readonly outer?: (rows: StepRows) => StepRows;
  /** Another step the wrapped S1-02 writer is bound to as well (a binding's fault). */
  readonly wrappedAt?: string;
}

/** Item 78's 243 seeded kinds (T-212), planned once for the file: T-633's writer's catalog double. */
let catalog: CatalogKind[] | undefined;

/** The walk H1a binds, on T-1491's test graph, with every read and S1-02's rows written down. */
function walkOf(given: Given = {}) {
  const companies = fakeCompaniesK05(given);
  catalog ??= seededCatalog();
  const kinds = fakeK05({ kinds: catalog, picks: given.picks ?? [] });
  const writers = kindsWriters<WalkTestRepo>(writerDeps(kinds.k05));
  const trades = tradesOverV1();
  const plugIns = createPlugInWriters<WalkTestRepo>({ bundles: trades.bundles });
  const oneKind = createOneKind<WalkTestRepo>({ reads: companiesReadsOf(companies.k05) });
  const bound = given.oneKind !== false;
  const seen: { inner?: StepRows; wrapped?: StepRows } = {};
  const inner = given.s1_02 ?? writers["S1-02"];
  const recorded: StepWriter<WalkTestRepo> = async (call) => {
    const rows = await inner(call);
    seen.inner = rows;
    return rows;
  };
  const placing = bound && given.noWrap !== true ? oneKind.wrap(recorded) : recorded;
  const outer: StepWriter<WalkTestRepo> = async (call) => {
    const rows = await placing(call);
    seen.wrapped = rows;
    return given.outer === undefined ? rows : given.outer(rows);
  };
  const s1_02 = plugIns.kinds(outer);
  const byStep: Record<string, StepWriter<WalkTestRepo>> = {
    "S1-02": s1_02,
    "S1-03": writers["S1-03"],
    "S1-74": writers["S1-74"],
    "S1-11": plugIns.plugIns,
    "S1-08": tellingWriter,
  };
  if (given.wrappedAt !== undefined) byStep[given.wrappedAt] = s1_02;
  const writesOf = createWritesOf<WalkTestRepo>({
    bundles: bundleV1Bundles({ A: flowAWithPlan() }).bundles,
    turnKey: () => SAM,
    questions: questionsOver().questions,
    writers: (stepId) => byStep[stepId] ?? null,
    ...(bound ? { buttonsSettlers: oneKind.buttonsSettlers } : {}),
  });
  return { writesOf, companies, kinds, trades, oneKind, seen };
}

type Walk = ReturnType<typeof walkOf>;

/** Turn 2 choosing `choiceId` with `words`, walked. */
async function answer(walk: Walk, choiceId: string, words: string) {
  const turn = turnWithWords(choiceId, words);
  const writes = await walk.writesOf(turn.part, turn.context, NOTHING_OPEN);
  return { ...turn, writes };
}

/** What turn 2 choosing `choiceId` with `words` threw on the walk (it must throw). */
async function refusal(walk: Walk, choiceId: string, words: string): Promise<unknown> {
  const turn = turnWithWords(choiceId, words);
  return walk.writesOf(turn.part, turn.context, NOTHING_OPEN).then(
    () => {
      throw new Error("the walk wrote");
    },
    (thrown: unknown) => thrown,
  );
}

/** The refusal's fault, held to its class. */
function faultOf(thrown: unknown): CompaniesFault {
  expect(thrown).toBeInstanceOf(CompaniesRefusedError);
  return (thrown as CompaniesRefusedError).fault;
}

/** The read error's read and fault, held to its class. */
function readFaultOf(thrown: unknown): [string, CompaniesReadFault] {
  expect(thrown).toBeInstanceOf(CompaniesReadError);
  const error = thrown as CompaniesReadError;
  return [error.read, error.fault];
}

/** A plumber company kind under Sam's company of Lee's Barbershop, with the catalog's facts and switches. */
function plumberKind(): StateWrite {
  return companyKindInsert(SAM_COMPANY, SAM_BUSINESS, "plumber", catalogDefaults("plumber"));
}

/** The picked_kinds insert of turn key sam's `n`th pick, as T-633's writer writes it, placed when `placed`. */
function pickInsert(
  n: number,
  position: number,
  words: string,
  kindId: string,
  placed: boolean,
  now: string,
) {
  return {
    op: "insert",
    table: "picked_kinds",
    values: {
      id: `pick-s1-02-sam-${String(n)}`,
      owner_person_id: SAM_PERSON,
      position,
      words,
      outcome: kindId.startsWith("new-") ? "new_work" : "listed",
      kind_id: kindId,
      company_id: placed ? SAM_COMPANY : null,
      business_id: placed ? SAM_BUSINESS : null,
      picked_at: now,
    },
  };
}

/** A stand-in S1-02 writer: the inserts given (none by default), giving kinds. It reads nothing. */
function standIn(state: readonly StateWrite[] = []): StepWriter<WalkTestRepo> {
  return () =>
    Promise.resolve({ state: [...state], stateEvents: [], gives: ["kinds"], asks: [], messages: [] });
}

/** A picked_kinds insert a stand-in gives: Sam's, listed, unless the values given say otherwise. */
function standInPick(values: Record<string, unknown>): StateWrite {
  return {
    op: "insert",
    table: "picked_kinds",
    values: {
      owner_person_id: SAM_PERSON,
      position: 1,
      words: "Plumbing",
      outcome: "listed",
      kind_id: "plumber",
      company_id: null,
      business_id: null,
      picked_at: "2026-10-19T14:05:06Z",
      ...values,
    },
  };
}

/** The S1-04 question, S1-08's row and S1-09's question, as the walk names them. */
function stepsAsked(writes: { asks: readonly { question: { step: string } }[] }): string[] {
  return writes.asks.map((ask) => ask.question.step);
}

describe("exactly one kept kind: S1-04 walked, the pick placed on its own insert", () => {
  it("'Plumbing' gives one placed insert under the turn's company and business, with a plumbing company kind inserted before it", async () => {
    const walk = walkOf();
    const { writes, context } = await answer(walk, ALL, "Plumbing");
    const now = context.request.now;
    const [kind, pick, ...texts] = writes.state;
    expect(kind).toEqual(plumberKind());
    expect(kind).toEqual({
      op: "insert",
      table: "company_kinds",
      values: {
        company_id: "company-lees-barbershop",
        kind_id: "plumber",
        business_id: "biz-lees-barbershop",
        trade_name: null,
        pf_facts: catalogDefaults("plumber").facts,
        pf_switches_a: catalogDefaults("plumber").switchesA,
        pf_switches_b: catalogDefaults("plumber").switchesB,
      },
    });
    expect(pick).toEqual(pickInsert(1, 1, "Plumbing", "plumber", true, now));
    // S1-11's eleven text rows (T-634's, outside the wrapper) take the placed pick's business.
    expect(texts).toHaveLength(11);
    expect(
      texts.map((write) =>
        write.op === "insert"
          ? [write.table, write.values.picked_kind_id, write.values.pf_key, write.values.business_id]
          : null,
      ),
    ).toEqual(PF_TEXT_KEYS.map((key) => ["picked_kind_texts", "pick-s1-02-sam-1", key, SAM_BUSINESS]));
    // No S1-04 question: S1-08's row, then S1-09's question and its row.
    expect(stepsAsked(writes)).toEqual(["S1-09"]);
    expect(writes.messages.map((row) => row.id)).toEqual(["outbox-s1-08-sam-1", "outbox-s1-09-sam-1"]);
    expect(writes.closes).toEqual([
      { id: "oq-s1-02", expectVersion: 2, status: "answered", answeredOptionId: null },
    ]);
    expect(writes.gives).toEqual(["kinds", ...PF_TEXT_KEYS, COMPANIES]);
    expect(writes.stateEvents).toEqual([]);
    // One read of each: item 79 under the call's business and the turn's person, item 72 on the call's repo, the catalog.
    expect(walk.companies.asked.map((each) => each.read)).toEqual([
      "readPickedKinds",
      "readBusinessKinds",
      "readTurnState",
    ]);
    const [picks, business, catalog] = walk.companies.asked;
    expect(picks).toEqual({
      read: "readPickedKinds",
      request: { businessId: SAM_BUSINESS, personId: SAM_PERSON },
    });
    expect(business).toEqual({
      read: "readBusinessKinds",
      repo: context.repo,
      request: { businessId: SAM_BUSINESS },
    });
    expect(catalog).toEqual({
      read: "readTurnState",
      repo: context.repo,
      request: {
        handleId: SAM_HANDLE,
        businessId: SAM_BUSINESS,
        bookingIds: [],
        facts: [
          { key: "kind.facts", table: "kinds", rowId: "plumber", column: "facts" },
          { key: "kind.switches.A", table: "kind_flows", rowId: "plumber/A", column: "switches_on" },
          { key: "kind.switches.B", table: "kind_flows", rowId: "plumber/B", column: "switches_on" },
        ],
      },
    });
  });

  it("the plumber company kind matches K-09 commit-s1-04.json's, the catalog's facts and switches", async () => {
    const walk = walkOf();
    const { writes } = await answer(walk, ALL, "Plumbing");
    const [kind] = writes.state;
    const exchange = fixture("commit-s1-04.json") as {
      given: { stated: { writes: { state: StateWrite[] } } };
    };
    const [stated] = exchange.given.stated.writes.state;
    if (stated?.op !== "insert" || kind?.op !== "insert") throw new Error("both insert a company kind");
    // The fixture's roster company and business stand where Sam's are; every other value is the catalog's.
    expect(kind.values).toEqual({ ...stated.values, company_id: SAM_COMPANY, business_id: SAM_BUSINESS });
    expect(stated.values).toMatchObject({ kind_id: "plumber", trade_name: null });
  });

  it("the rows pass K-05's shapes and build commitTurn.request, with K-08 event-log rows", async () => {
    const walk = walkOf();
    const { writes, context, exchange } = await answer(walk, ALL, "Plumbing");
    const checks = contractChecks();
    for (const write of writes.state) expect(checks.k05("stateWrite", write)).toEqual([]);
    for (const ask of writes.asks) expect(checks.k05("openQuestionNew", ask.question)).toEqual([]);
    for (const row of writes.messages) expect(checks.k05("outboxRowNew", row)).toEqual([]);
    const { people } = decidedOf(context.request).context.writer;
    const person = people.find((each) => each.personId === SAM_PERSON);
    const request = buildCommitRequest({
      turn: context.turn,
      zone: "America/New_York",
      businessId: context.businessId,
      actor: {
        personId: SAM_PERSON,
        roleAt: (businessId) => person?.roles.find((role) => role.businessId === businessId)?.role ?? null,
      },
      units: [{ writes, answer: { openQuestionId: "oq-s1-02", optionId: null, eventId: "evt-sam-0001" } }],
    });
    expect(checks.k05("commitTurn.request", request)).toEqual([]);
    for (const row of eventLogRowsOf(request, exchange.request.now)) {
      expect(checks.k08("eventLogRow", row), String(row.id)).toEqual([]);
    }
  });

  it("the turn's company's barber company kind on file is kept, never inserted again", async () => {
    const walk = walkOf();
    const { writes, context } = await answer(walk, ALL, "Barbershop");
    const [pick, ...texts] = writes.state;
    expect(pick).toEqual(pickInsert(1, 1, "Barbershop", "barber", true, context.request.now));
    expect(writes.state.filter((write) => write.table === "company_kinds")).toEqual([]);
    expect(texts).toHaveLength(11);
    expect(stepsAsked(writes)).toEqual(["S1-09"]);
    // The company kind is on file, so the catalog is not read.
    expect(walk.companies.asked.map((each) => each.read)).toEqual(["readPickedKinds", "readBusinessKinds"]);
  });

  it("one kept pick plus one not_booked counts as one", async () => {
    const giftCards = pickOnFile({
      id: "pick-sam-gift-cards",
      words: GIFT_CARDS,
      outcome: "not_booked",
      kindId: null,
    });
    const walk = walkOf({ picks: [giftCards] });
    const { writes, context } = await answer(walk, ALL, "Plumbing");
    const [kind, pick] = writes.state;
    expect(kind).toEqual(plumberKind());
    // T-633 numbers the new pick after item 79's (position 2); the wrapper places it.
    expect(pick).toEqual(pickInsert(1, 2, "Plumbing", "plumber", true, context.request.now));
    expect(stepsAsked(writes)).toEqual(["S1-09"]);
  });

  it("a kind picked again in one answer counts once ('Plumbing, plumbing')", async () => {
    const walk = walkOf();
    const { writes, context } = await answer(walk, ALL, "Plumbing, plumbing");
    expect(writes.state.filter((write) => write.table === "picked_kinds")).toEqual([
      pickInsert(1, 1, "Plumbing", "plumber", true, context.request.now),
    ]);
    expect(stepsAsked(writes)).toEqual(["S1-09"]);
  });

  it("'One isn't on the list yet' with one new kind: the drafted pick placed on its insert, its company kind the protective facts", async () => {
    const walk = walkOf();
    const { writes } = await answer(walk, ONE_NEW, PACK_HIKES);
    const [drafted, kind, pick, draft] = writes.state;
    expect(drafted).toMatchObject({ op: "insert", table: "kinds", values: { source: "new_work" } });
    const kindId = drafted?.op === "insert" ? String(drafted.values.id) : "";
    expect(kind).toEqual(
      companyKindInsert(SAM_COMPANY, SAM_BUSINESS, kindId, {
        facts: ["documents", "forms"],
        switchesA: [],
        switchesB: [],
      }),
    );
    expect(pick).toMatchObject({
      op: "insert",
      table: "picked_kinds",
      values: { outcome: "new_work", kind_id: kindId, company_id: SAM_COMPANY, business_id: SAM_BUSINESS },
    });
    expect(draft).toMatchObject({ op: "insert", table: "new_work_drafts" });
    expect(writes.state).toHaveLength(4);
    expect(stepsAsked(writes)).toEqual(["S1-09"]);
    // A drafted kind's facts come from its draft, never the catalog.
    expect(walk.companies.asked.map((each) => each.read)).toEqual(["readPickedKinds", "readBusinessKinds"]);
  });
});

describe("one kept kind on file: the settler places it by an update at the version read", () => {
  /** Sam's plumbing pick on file, unplaced, at version 3, with its 11 text blocks (no business yet). */
  function plumbingOnFile() {
    return pickOnFile({
      id: "pick-sam-plumbing",
      version: 3,
      texts: PF_TEXT_KEYS.map((key, index) => ({
        rowId: `pick-sam-plumbing/${key}`,
        pfKey: key,
        businessId: null,
        version: index + 1,
      })) as ReturnType<typeof pickOnFile>["texts"],
    });
  }

  it("a kind picked again ('Plumbing' with plumbing on file) counts once: the pick on file placed by its update, its texts given the business", async () => {
    const walk = walkOf({ picks: [plumbingOnFile()] });
    const { writes, context } = await answer(walk, ALL, "Plumbing");
    expect(writes.state).toEqual([
      plumberKind(),
      {
        op: "update",
        table: "picked_kinds",
        key: { id: "pick-sam-plumbing" },
        expectVersion: 3,
        set: { company_id: SAM_COMPANY, business_id: SAM_BUSINESS },
      },
      ...PF_TEXT_KEYS.map((key, index) => ({
        op: "update",
        table: "picked_kind_texts",
        key: { picked_kind_id: "pick-sam-plumbing", pf_key: key },
        expectVersion: index + 1,
        set: { business_id: SAM_BUSINESS },
      })),
    ]);
    // T-633 picks nothing again (kinds/answer.ts default 3), so the wrapper reads nothing and S1-11 loads nothing.
    expect(walk.seen.inner?.state).toEqual([]);
    expect(walk.seen.wrapped).toBe(walk.seen.inner);
    expect(stepsAsked(writes)).toEqual(["S1-09"]);
    expect(writes.gives).toEqual(["kinds", COMPANIES]);
    expect(walk.companies.asked.map((each) => each.read)).toEqual([
      "readPickedKinds",
      "readBusinessKinds",
      "readTurnState",
    ]);
    expect(walk.companies.asked[1]).toMatchObject({ repo: context.repo });
  });

  it("a drafted pick on file is placed with its draft and blocks, its company kind from the draft's answered blocks", async () => {
    const drafted = pickOnFile({
      id: "pick-sam-hikes",
      words: PACK_HIKES,
      outcome: "new_work",
      kindId: "new-0123456789abcdef",
      version: 2,
      draft: {
        id: "draft-sam-hikes",
        businessId: null,
        state: "drafting",
        draftedAt: "2026-10-19T14:01:00Z",
        version: 4,
        blocks: [
          {
            rowId: "draft-sam-hikes/7",
            block: 7,
            businessId: null,
            outcome: "answered",
            factsOn: ["photos", "forms"],
            switchesOn: ["cancelright"],
            answeredAt: "2026-10-19T14:02:00Z",
            version: 1,
          },
          {
            rowId: "draft-sam-hikes/3",
            block: 3,
            businessId: null,
            outcome: "no",
            factsOn: [],
            switchesOn: [],
            answeredAt: "2026-10-19T14:02:00Z",
            version: 2,
          },
        ],
      },
    });
    const walk = walkOf({ picks: [drafted], s1_02: standIn() });
    const { writes } = await answer(walk, ALL, "Plumbing");
    expect(writes.state).toEqual([
      companyKindInsert(SAM_COMPANY, SAM_BUSINESS, "new-0123456789abcdef", {
        facts: ["documents", "forms", "photos"],
        switchesA: ["cancelright"],
        switchesB: ["cancelright"],
      }),
      {
        op: "update",
        table: "picked_kinds",
        key: { id: "pick-sam-hikes" },
        expectVersion: 2,
        set: { company_id: SAM_COMPANY, business_id: SAM_BUSINESS },
      },
      {
        op: "update",
        table: "new_work_drafts",
        key: { id: "draft-sam-hikes" },
        expectVersion: 4,
        set: { business_id: SAM_BUSINESS },
      },
      {
        op: "update",
        table: "new_work_draft_blocks",
        key: { draft_id: "draft-sam-hikes", block: 7 },
        expectVersion: 1,
        set: { business_id: SAM_BUSINESS },
      },
      {
        op: "update",
        table: "new_work_draft_blocks",
        key: { draft_id: "draft-sam-hikes", block: 3 },
        expectVersion: 2,
        set: { business_id: SAM_BUSINESS },
      },
    ]);
    expect(walk.companies.asked.map((each) => each.read)).toEqual(["readPickedKinds", "readBusinessKinds"]);
  });

  it("the pick on file with its company kind on file: only its update, no company kind", async () => {
    const barber = pickOnFile({ id: "pick-sam-barbershop", words: "Barbershop", kindId: "barber" });
    const walk = walkOf({ picks: [barber], s1_02: standIn() });
    const { writes } = await answer(walk, ALL, "Barbershop");
    expect(writes.state).toEqual([
      {
        op: "update",
        table: "picked_kinds",
        key: { id: "pick-sam-barbershop" },
        expectVersion: 1,
        set: { company_id: SAM_COMPANY, business_id: SAM_BUSINESS },
      },
    ]);
  });

  it("the pick on file placed already in the turn's company: companies given, no row", async () => {
    const placed = pickOnFile({ id: "pick-sam-plumbing", companyId: SAM_COMPANY, businessId: SAM_BUSINESS });
    const walk = walkOf({ picks: [placed], s1_02: standIn() });
    const { writes } = await answer(walk, ALL, "Plumbing");
    expect(writes.state).toEqual([]);
    expect(writes.gives).toEqual(["kinds", COMPANIES]);
    expect(stepsAsked(writes)).toEqual(["S1-09"]);
    expect(walk.companies.asked.map((each) => each.read)).toEqual(["readPickedKinds"]);
  });
});

describe("two or more kept kinds: 'ask', and S1-02's rows go back unchanged", () => {
  it("a second kind on file counts as two: S1-02's rows unchanged, S1-04 asked exactly as with nothing bound", async () => {
    const walk = walkOf({ picks: [earlierPick()] });
    const { writes } = await answer(walk, ALL, "Plumbing");
    expect(walk.seen.wrapped).toBe(walk.seen.inner);
    const today = walkOf({ picks: [earlierPick()], oneKind: false });
    const { writes: unbound } = await answer(today, ALL, "Plumbing");
    expect(writes).toEqual(unbound);
    expect(stepsAsked(writes)).toEqual(["S1-04"]);
    expect(writes.gives).not.toContain(COMPANIES);
    // Item 79 once, shared by the wrapper and the settler; nothing else read.
    expect(walk.companies.asked.map((each) => each.read)).toEqual(["readPickedKinds"]);
  });

  it("Sam's 'Barbershop, plumbing, electrical' counts three: commit-s1-02.json's walk, S1-04 asked", async () => {
    const walk = walkOf();
    const { writes } = await answer(walk, ALL, "Barbershop, plumbing, electrical");
    const { writes: unbound } = await answer(
      walkOf({ oneKind: false }),
      ALL,
      "Barbershop, plumbing, electrical",
    );
    expect(writes).toEqual(unbound);
    expect(walk.seen.wrapped).toBe(walk.seen.inner);
    expect(stepsAsked(writes)).toEqual(["S1-04"]);
  });

  it("two drafted kinds count as two (each drafted kind is its own)", async () => {
    const twoDrafts = standIn([
      standInPick({ id: "pick-a", outcome: "new_work", kind_id: "new-aaaaaaaaaaaaaaaa", words: PACK_HIKES }),
      standInPick({ id: "pick-b", outcome: "new_work", kind_id: "new-bbbbbbbbbbbbbbbb", position: 2 }),
    ]);
    const walk = walkOf({ s1_02: twoDrafts });
    const { writes } = await answer(walk, ALL, "Plumbing");
    expect(walk.seen.wrapped).toBe(walk.seen.inner);
    expect(stepsAsked(writes)).toEqual(["S1-04"]);
  });

  it("'Not a service we book' reads nothing and never reaches S1-04", async () => {
    const walk = walkOf();
    const { writes } = await answer(walk, NOT_A_SERVICE, GIFT_CARDS);
    expect(walk.seen.wrapped).toBe(walk.seen.inner);
    expect(walk.companies.asked).toEqual([]);
    expect(stepsAsked(writes)).toEqual([]);
  });
});

describe("each refusal: the call fails closed with nothing written", () => {
  it("noKeptPick: no kept pick in the walk or on file (a not_booked pick on file alone)", async () => {
    const giftCards = pickOnFile({ id: "pick-sam-gift-cards", outcome: "not_booked", kindId: null });
    const walk = walkOf({ picks: [giftCards], s1_02: standIn() });
    expect(faultOf(await refusal(walk, ALL, "Plumbing"))).toBe("noKeptPick");
  });

  it("noTurnCompany: the caller's person owns no company of the call's business (wrapper and settler)", async () => {
    const otherOwner = samCompanies().map((company) => ({ ...company, ownerPersonId: "person-alex" }));
    expect(faultOf(await refusal(walkOf({ companies: otherOwner }), ALL, "Plumbing"))).toBe("noTurnCompany");
    expect(faultOf(await refusal(walkOf({ companies: [] }), ALL, "Plumbing"))).toBe("noTurnCompany");
    const onFile = pickOnFile({ id: "pick-sam-plumbing" });
    const settled = walkOf({ companies: [], picks: [onFile], s1_02: standIn() });
    expect(faultOf(await refusal(settled, ALL, "Plumbing"))).toBe("noTurnCompany");
  });

  it("twoPicksOneKind: one kind with two kept picks, inserted twice or inserted and on file", async () => {
    const twice = walkOf({
      s1_02: standIn([standInPick({ id: "pick-a" }), standInPick({ id: "pick-b", position: 2 })]),
    });
    expect(faultOf(await refusal(twice, ALL, "Plumbing"))).toBe("twoPicksOneKind");
    const both = walkOf({
      picks: [pickOnFile({ id: "pick-sam-plumbing" })],
      s1_02: standIn([standInPick({ id: "pick-a", position: 2 })]),
    });
    expect(faultOf(await refusal(both, ALL, "Plumbing"))).toBe("twoPicksOneKind");
  });

  it("placedElsewhere: the one pick on file placed in another company", async () => {
    const elsewhere = pickOnFile({
      id: "pick-sam-plumbing",
      companyId: "company-sam-other",
      businessId: null,
    });
    const walk = walkOf({ picks: [elsewhere], s1_02: standIn() });
    expect(faultOf(await refusal(walk, ALL, "Plumbing"))).toBe("placedElsewhere");
  });

  it("notPlaced: the settler bound with S1-02's writer left unwrapped", async () => {
    expect(faultOf(await refusal(walkOf({ noWrap: true }), ALL, "Plumbing"))).toBe("notPlaced");
  });

  it("placementDisagrees: the rows built no longer hold the wrapper's placement", async () => {
    const unplace = (rows: StepRows): StepRows => ({
      ...rows,
      state: rows.state.map((write) =>
        write.op === "insert" && write.table === "picked_kinds"
          ? { ...write, values: { ...write.values, company_id: null, business_id: null } }
          : write,
      ),
    });
    expect(faultOf(await refusal(walkOf({ outer: unplace }), ALL, "Plumbing"))).toBe("placementDisagrees");
    const noKind = (rows: StepRows): StepRows => ({
      ...rows,
      state: rows.state.filter((write) => write.table !== "company_kinds"),
    });
    // Without its company kind the commit's foreign key would refuse the pick; the settler refuses first.
    expect(faultOf(await refusal(walkOf({ outer: noKind }), ALL, "Plumbing"))).toBe("placementDisagrees");
    const another = (rows: StepRows): StepRows => ({
      ...rows,
      state: [...rows.state, standInPick({ id: "pick-extra", kind_id: "electrician", position: 9 })],
    });
    expect(faultOf(await refusal(walkOf({ outer: another }), ALL, "Plumbing"))).toBe("placementDisagrees");
  });

  it("pickNotWellFormed and notOwnPick: S1-02's rows not K-24's shape, or another person's pick", async () => {
    const badOutcome = walkOf({ s1_02: standIn([standInPick({ id: "pick-a", outcome: "maybe" })]) });
    expect(faultOf(await refusal(badOutcome, ALL, "Plumbing"))).toBe("pickNotWellFormed");
    const noKind = walkOf({ s1_02: standIn([standInPick({ id: "pick-a", kind_id: null })]) });
    expect(faultOf(await refusal(noKind, ALL, "Plumbing"))).toBe("pickNotWellFormed");
    const noId = walkOf({ s1_02: standIn([standInPick({ id: "" })]) });
    expect(faultOf(await refusal(noId, ALL, "Plumbing"))).toBe("pickNotWellFormed");
    const alex = walkOf({ s1_02: standIn([standInPick({ id: "pick-a", owner_person_id: "person-alex" })]) });
    expect(faultOf(await refusal(alex, ALL, "Plumbing"))).toBe("notOwnPick");
  });

  it("noPerson: the turn names no person", async () => {
    const walk = walkOf({ s1_02: standIn() });
    const turn = turnWithWords(ALL, "Plumbing");
    const caller = turn.context.request.caller as { personId: string | null };
    caller.personId = null;
    const thrown = await walk.writesOf(turn.part, turn.context, NOTHING_OPEN).then(
      () => null,
      (error: unknown) => error,
    );
    expect(faultOf(thrown)).toBe("noPerson");
  });

  it("wrongStep: the wrapper's writer bound to another step, the settler asked at another step", async () => {
    // S1-02's wrapped writer bound at S1-11 as well: the walk calls it there, and it refuses.
    const walk = walkOf({ wrappedAt: "S1-11" });
    const thrown = await refusal(walk, ALL, "Plumbing");
    expect(faultOf(thrown)).toBe("wrongStep");
    expect((thrown as CompaniesRefusedError).ids).toEqual(["S1-02", "S1-11"]);
    const { oneKind } = walkOf();
    const turn = turnWithWords(ALL, "Plumbing");
    const step = flowGraphOf(flowAWithPlan(), "A").step("S1-08");
    if (step === null || turn.part.choice === null)
      throw new Error("the graph holds S1-08, the part a choice");
    const call: ButtonsSettlerCall<WalkTestRepo> = {
      repo: turn.context.repo,
      businessId: turn.context.businessId,
      step,
      part: turn.part,
      choice: turn.part.choice,
      turn: turn.context,
      rows: { versionsRead: [], state: [], stateEvents: [], asks: [], closes: [], messages: [], gives: [] },
    };
    const settled = await oneKind.settler(call).then(
      () => null,
      (error: unknown) => error,
    );
    expect(faultOf(settled)).toBe("wrongStep");
    expect(oneKind.buttonsSettlers("S1-04")).toBe(oneKind.settler);
    expect(oneKind.buttonsSettlers("S1-08")).toBeNull();
    expect(oneKind.buttonsSettlers("S1-02")).toBeNull();
  });
});

describe("a failed item 79, item 72 or catalog read rejects, never read as none", () => {
  it("item 79: transient or notFound, or a throw, rejects (the wrapper's read, and the settler's)", async () => {
    const transient = walkOf({ picked: { error: "transient", sqlstate: "40001" } });
    expect(readFaultOf(await refusal(transient, ALL, "Plumbing"))).toEqual(["readPickedKinds", "transient"]);
    const notFound = walkOf({ picked: { error: "notFound", table: "persons", rowId: "person-sam" } });
    expect(readFaultOf(await refusal(notFound, ALL, "Plumbing"))).toEqual(["readPickedKinds", "notFound"]);
    const lost = new Error("connection lost");
    const thrown = walkOf({ throws: { read: "readPickedKinds", error: lost } });
    expect(await refusal(thrown, ALL, "Plumbing")).toBe(lost);
    // The settler's own read, when the wrapper read nothing.
    const settler = walkOf({ picked: { error: "transient", sqlstate: "40P01" }, s1_02: standIn() });
    expect(readFaultOf(await refusal(settler, ALL, "Plumbing"))).toEqual(["readPickedKinds", "transient"]);
  });

  it("item 72: notFound or transient, or a throw, rejects", async () => {
    const notFound = walkOf({
      businessKinds: { error: "notFound", table: "businesses", rowId: SAM_BUSINESS },
    });
    expect(readFaultOf(await refusal(notFound, ALL, "Plumbing"))).toEqual(["readBusinessKinds", "notFound"]);
    const transient = walkOf({ businessKinds: { error: "transient", sqlstate: "40001" } });
    expect(readFaultOf(await refusal(transient, ALL, "Plumbing"))).toEqual([
      "readBusinessKinds",
      "transient",
    ]);
    const lost = new Error("connection lost");
    expect(
      await refusal(walkOf({ throws: { read: "readBusinessKinds", error: lost } }), ALL, "Plumbing"),
    ).toBe(lost);
  });

  it("the catalog by id: notFound, unknownFact, transient, a value that is no list of names, or a throw, rejects", async () => {
    const notFound = walkOf({ turnState: { error: "notFound", table: "kind_flows", rowId: "plumber/B" } });
    expect(readFaultOf(await refusal(notFound, ALL, "Plumbing"))).toEqual(["readTurnState", "notFound"]);
    const unknown = walkOf({
      turnState: { error: "unknownFact", key: "kind.facts", table: "kinds", column: "facts" },
    });
    expect(readFaultOf(await refusal(unknown, ALL, "Plumbing"))).toEqual(["readTurnState", "unknownFact"]);
    const transient = walkOf({ turnState: { error: "transient", sqlstate: "40001" } });
    expect(readFaultOf(await refusal(transient, ALL, "Plumbing"))).toEqual(["readTurnState", "transient"]);
    const lost = new Error("connection lost");
    expect(await refusal(walkOf({ throws: { read: "readTurnState", error: lost } }), ALL, "Plumbing")).toBe(
      lost,
    );
  });
});

describe("the reads and the helpers T-1481 reuses", () => {
  /** readTurnState's answer to the catalog facts, with the values given (in the order asked). */
  async function defaultsWith(values: readonly unknown[], twice = false) {
    const fake = fakeCompaniesK05();
    const reads = companiesReadsOf({
      ...fake.k05,
      async readTurnState(repo, request) {
        const answer = await fake.k05.readTurnState(repo, request);
        if ("error" in answer) return answer;
        const facts = answer.facts.map((fact, index) => ({ ...fact, value: values[index] }));
        return { ...answer, facts: twice ? [...facts, ...facts] : facts };
      },
    });
    const request = { handleId: SAM_HANDLE, businessId: SAM_BUSINESS, kindId: "plumber" };
    return reads.kindDefaults({ name: "walk-test-repo" }, request).then(
      (defaults) => defaults,
      (error: unknown) => error,
    );
  }

  it("a trade-file kind with no facts (null) has none on; a value that is no list of names, or a fact answered twice, is refused", async () => {
    expect(await defaultsWith([null, [], ["cancelright"]])).toEqual({
      facts: [],
      switchesA: [],
      switchesB: ["cancelright"],
    });
    expect(readFaultOf(await defaultsWith([["Bad name"], [], []]))).toEqual([
      "readTurnState",
      "notWellFormed",
    ]);
    expect(readFaultOf(await defaultsWith([[], "cancelright", []]))).toEqual([
      "readTurnState",
      "notWellFormed",
    ]);
    expect(readFaultOf(await defaultsWith([[], [], null]))).toEqual(["readTurnState", "notWellFormed"]);
    expect(readFaultOf(await defaultsWith([[], [], []], true))).toEqual(["readTurnState", "notWellFormed"]);
  });

  it("an answer for another business or person is refused", async () => {
    const other = fakeCompaniesK05({
      picked: {
        result: "pickedKinds",
        businessId: "biz-lee-home-services",
        personId: SAM_PERSON,
        readAt: "2026-10-19T14:05:06Z",
        picks: [],
        companies: [],
      },
      businessKinds: {
        result: "businessKinds",
        businessId: "biz-lee-home-services",
        readAt: "2026-10-19T14:05:06Z",
        setup: null,
        kinds: [],
      },
    });
    const reads = companiesReadsOf(other.k05);
    const picks = await reads
      .pickedKinds({ businessId: SAM_BUSINESS, personId: SAM_PERSON })
      .catch((e: unknown) => e);
    expect(readFaultOf(picks)).toEqual(["readPickedKinds", "notWellFormed"]);
    const kinds = await reads
      .businessKinds({ name: "walk-test-repo" }, { businessId: SAM_BUSINESS })
      .catch((e: unknown) => e);
    expect(readFaultOf(kinds)).toEqual(["readBusinessKinds", "notWellFormed"]);
  });

  it("turnCompanyOf, companyKindOnFile and draftedDefaults", () => {
    expect(turnCompanyOf({ companies: samCompanies() }, SAM_PERSON, SAM_BUSINESS)?.id).toBe(SAM_COMPANY);
    expect(turnCompanyOf({ companies: samCompanies() }, "person-alex", SAM_BUSINESS)).toBeNull();
    expect(turnCompanyOf({ companies: samCompanies() }, SAM_PERSON, "biz-lee-home-services")).toBeNull();
    expect(companyKindOnFile({ kinds: seedCompanyKinds() }, SAM_COMPANY, "barber")?.rowId).toBe(
      "company-lees-barbershop/barber",
    );
    expect(companyKindOnFile({ kinds: seedCompanyKinds() }, SAM_COMPANY, "plumber")).toBeNull();
    expect(draftedDefaults(null)).toEqual({ facts: [...PROTECTIVE_FACTS], switchesA: [], switchesB: [] });
    const block = (
      n: number,
      factsOn: string[],
      switchesOn: string[],
      outcome: "answered" | "no" = "answered",
    ) => ({
      rowId: `draft/${String(n)}`,
      block: n,
      businessId: null,
      outcome,
      factsOn,
      switchesOn,
      answeredAt: "2026-10-19T14:02:00Z",
      version: 1,
    });
    expect(
      draftedDefaults({
        blocks: [
          block(9, ["video"], ["planbill"]),
          block(2, ["forms", "photos"], ["cancelright"]),
          block(5, [], [], "no"),
        ],
      }),
    ).toEqual({
      facts: ["documents", "forms", "photos", "video"],
      switchesA: ["cancelright", "planbill"],
      switchesB: ["cancelright", "planbill"],
    });
  });
});
