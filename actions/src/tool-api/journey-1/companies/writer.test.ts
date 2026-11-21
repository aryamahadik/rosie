// T-1481: S1-04's read-only step writer (K-09 README v1.11 defaults 182 to 184 and 190; card 12 of the S1-04 design
// ruling, decision (c); DL-999, DL-1088). The code under test is companiesWriter, called as the walk calls a step writer
// (writes.ts `written`) on K-09's own S1-04 answers: commit-s1-04.json (the roster owner's "All share one") and
// commit-s1-04-some-share.json (Sam's "Some share one"), with another button or other fields where a case needs them.
// Only the K-05 reads are doubles (items 79 and 72 and readTurnState's catalog facts by id, as db/repo answers them:
// test-support.ts), never the writer or the helpers it reuses from T-1492. Round 2 (DL-1094) also holds the writer's
// rows to K-09's own buttonsAnswerCommit (tool-api.rules.mjs) where a case states a whole answer, so a rule refusal shows
// up here: the company under way updated whenever the owner names it, company_name's value as the name, and a gained
// business's rows table by table.

import { describe, expect, it } from "vitest";

import type { PickedKindRead } from "../../../../../db/repo/kinds-reads";
import type { StateWrite } from "../../../commit/types";
import type { WalkTestRepo } from "../../../commit/walk/test-support";
import { PF_TEXT_KEYS } from "../plug-ins";
import {
  COMPANIES,
  COMPANY_NAME,
  CompaniesReadError,
  CompaniesRefusedError,
  SHARED_KINDS,
  companiesReadsOf,
  companiesWriter,
  companyKindInsert,
  draftedDefaults,
  type CompaniesFault,
} from "./index";
import {
  COMMIT_S1_04,
  COMMIT_S1_04_SOME_SHARE,
  SAM_BUSINESS,
  SAM_COMPANY,
  SAM_PERSON,
  catalogDefaults,
  fakeCompaniesK05,
  graphStep,
  pickOnFile,
  s1_04CallOf,
  s1_04Exchange,
  s1_04RuleProblems,
  samCompanies,
  seedCompanyKinds,
  type AnswerField,
  type CommitS1_04,
  type CompaniesGiven,
} from "./test-support";

const SOME = "c-01";
const ALL = "c-02";
const EACH = "c-03";

/** The roster world of commit-s1-04.json (db/seeds/roster-owner.ts, place 1), its ids the fixture's stand-ins. */
const ROSTER_PERSON = "person-roster-owner-1";
const ROSTER_BUSINESS = "biz-roster-owner-1";
const ROSTER_COMPANY = "company-roster-owner-1";

/** A pick's 11 plug-in text blocks as item 79 answers them: in the pf keys' order, each at `version`, no business. */
function textsOf(pickId: string, version = 1): PickedKindRead["texts"] {
  // K-05 v1.19 types `texts` as a list of at most 11; the pf keys are exactly 11.
  return PF_TEXT_KEYS.map((key) => ({
    rowId: `${pickId}/${key}`,
    pfKey: key,
    businessId: null,
    version,
  })) as PickedKindRead["texts"];
}

/** commit-s1-04.json's note: two listed picks at version 1 with no company, plumbing first with its 11 blocks. */
function rosterWorld(): CompaniesGiven {
  return {
    picks: [
      pickOnFile({
        id: "pick-roster-plumbing",
        ownerPersonId: ROSTER_PERSON,
        words: "plumbing",
        texts: textsOf("pick-roster-plumbing"),
      }),
      pickOnFile({
        id: "pick-roster-electrical",
        ownerPersonId: ROSTER_PERSON,
        position: 2,
        words: "electrical",
        kindId: "electrician",
      }),
    ],
    companies: [
      {
        id: ROSTER_COMPANY,
        ownerPersonId: ROSTER_PERSON,
        name: "Lee's Barbershop LLC",
        businessId: ROSTER_BUSINESS,
        version: 2,
      },
    ],
    companyKinds: seedCompanyKinds().map((kind) => ({
      ...kind,
      rowId: `${ROSTER_COMPANY}/${kind.kindId}`,
      companyId: ROSTER_COMPANY,
      businessId: ROSTER_BUSINESS,
    })),
  };
}

/** Sam's three picks after commit-s1-02.json (commit-s1-04-some-share.json's note), the barbershop first with its blocks. */
function samPicks(): PickedKindRead[] {
  return [
    pickOnFile({
      id: "pick-sam-barbershop",
      words: "Barbershop",
      kindId: "barber",
      texts: textsOf("pick-sam-barbershop"),
    }),
    pickOnFile({ id: "pick-sam-plumbing", position: 2, words: "plumbing" }),
    pickOnFile({ id: "pick-sam-electrical", position: 3, words: "electrical", kindId: "electrician" }),
  ];
}

/** Sam's world: his three picks, his company of Lee's Barbershop and its barber company kind (the doubles' defaults). */
function samWorld(over: CompaniesGiven = {}): CompaniesGiven {
  return { picks: samPicks(), ...over };
}

/** Sam's answer to S1-04 on commit-s1-04-some-share.json's turn: the button and fields given. */
function samAnswer(choiceId: string, fields: readonly AnswerField[] = []): CommitS1_04 {
  return s1_04Exchange(COMMIT_S1_04_SOME_SHARE, choiceId, fields);
}

const shared = (words: string): AnswerField => ({ name: SHARED_KINDS, value: words, words });
const named = (words: string): AnswerField => ({ name: COMPANY_NAME, value: words, words });

/** S1-04's writer over the K-05 doubles answering `given`, with the party flag when given, and every read written down. */
function writerOver(given: CompaniesGiven, partyRuleLive?: boolean) {
  const fake = fakeCompaniesK05(given);
  const write = companiesWriter<WalkTestRepo>({
    reads: companiesReadsOf(fake.k05),
    ...(partyRuleLive === undefined ? {} : { partyRuleLive }),
  });
  return { write, asked: fake.asked };
}

/** The writer's rows for `exchange`'s part under turn key `turnKey`, and the reads it made. */
async function written(
  given: CompaniesGiven,
  exchange: CommitS1_04,
  turnKey = "sam",
  partyRuleLive?: boolean,
) {
  const writer = writerOver(given, partyRuleLive);
  const rows = await writer.write(s1_04CallOf(exchange.request, turnKey));
  return { rows, asked: writer.asked };
}

/** What the writer threw for `exchange`'s part (it must throw), and the reads it made first. */
async function refused(given: CompaniesGiven, exchange: CommitS1_04, partyRuleLive?: boolean) {
  const writer = writerOver(given, partyRuleLive);
  const thrown = await writer.write(s1_04CallOf(exchange.request, "sam")).then(
    () => {
      throw new Error("the writer answered rows");
    },
    (error: unknown) => error,
  );
  return { thrown, asked: writer.asked };
}

/** The refusal's fault, held to its class, naming S1-04 alone. */
function faultOf(thrown: unknown): CompaniesFault {
  expect(thrown).toBeInstanceOf(CompaniesRefusedError);
  return (thrown as CompaniesRefusedError).fault;
}

/** The read error's read and fault, held to its class. */
function readFaultOf(thrown: unknown): [string, string] {
  expect(thrown).toBeInstanceOf(CompaniesReadError);
  const error = thrown as CompaniesReadError;
  return [error.read, error.fault];
}

/** A pick placed by its update at `version`: its company, and its business where the company has one. */
function placed(pickId: string, version: number, companyId: string, businessId?: string): StateWrite {
  return {
    op: "update",
    table: "picked_kinds",
    key: { id: pickId },
    expectVersion: version,
    set:
      businessId === undefined
        ? { company_id: companyId }
        : { company_id: companyId, business_id: businessId },
  };
}

/** A pick's 11 text blocks given the business, each at version 1. */
function textsGiven(pickId: string, businessId: string): StateWrite[] {
  return PF_TEXT_KEYS.map((key) => ({
    op: "update",
    table: "picked_kind_texts",
    key: { picked_kind_id: pickId, pf_key: key },
    expectVersion: 1,
    set: { business_id: businessId },
  }));
}

/** A listed kind's company kind with the catalog's facts and switches. */
function kindOf(companyId: string, businessId: string | null, kindId: string): StateWrite {
  return companyKindInsert(companyId, businessId, kindId, catalogDefaults(kindId));
}

/** A new company of Sam's with no business (default 182 (1)). */
function newCompany(id: string, name: string): StateWrite {
  return {
    op: "insert",
    table: "companies",
    values: { id, owner_person_id: SAM_PERSON, name, business_id: null },
  };
}

/** The reads made, by name. */
const readsOf = (asked: { read: string }[]): string[] => asked.map((each) => each.read);

describe("'All share one': every kept pick in the company the turn runs under", () => {
  it("commit-s1-04.json: the roster owner's answer gives its state rows, field for field, with the flag off", async () => {
    const exchange = s1_04Exchange(COMMIT_S1_04);
    const { rows, asked } = await written(rosterWorld(), exchange, "roster");
    expect(rows.state).toEqual(exchange.given.stated.writes.state);
    // K-09's buttonsAnswerCommit holds the writer's own rows, as it holds the fixture's.
    expect(await s1_04RuleProblems(exchange, rows.state)).toEqual([]);
    expect(rows).toEqual({
      state: rows.state,
      stateEvents: [],
      gives: [COMPANIES],
      asks: [],
      messages: [],
    });
    // Item 79 under the call's business and the caller's person; item 72 and the catalog on the call's repo.
    expect(readsOf(asked)).toEqual([
      "readPickedKinds",
      "readBusinessKinds",
      "readTurnState",
      "readTurnState",
    ]);
    expect(asked[0]).toEqual({
      read: "readPickedKinds",
      request: { businessId: ROSTER_BUSINESS, personId: ROSTER_PERSON },
    });
    expect(asked[1]).toEqual({
      read: "readBusinessKinds",
      repo: { name: "walk-test-repo" },
      request: { businessId: ROSTER_BUSINESS },
    });
    expect(asked.slice(2)).toEqual(
      ["plumber", "electrician"].map((kindId) => ({
        read: "readTurnState",
        repo: { name: "walk-test-repo" },
        request: {
          handleId: "handle-roster-owner-1",
          businessId: ROSTER_BUSINESS,
          bookingIds: [],
          facts: [
            { key: "kind.facts", table: "kinds", rowId: kindId, column: "facts" },
            { key: "kind.switches.A", table: "kind_flows", rowId: `${kindId}/A`, column: "switches_on" },
            { key: "kind.switches.B", table: "kind_flows", rowId: `${kindId}/B`, column: "switches_on" },
          ],
        },
      })),
    );
  });

  it("places Sam's three picks in the turn's company: the company and its barber company kind kept, not inserted", async () => {
    const { rows } = await written(samWorld(), samAnswer(ALL));
    expect(rows.state).toEqual([
      kindOf(SAM_COMPANY, SAM_BUSINESS, "plumber"),
      kindOf(SAM_COMPANY, SAM_BUSINESS, "electrician"),
      placed("pick-sam-barbershop", 1, SAM_COMPANY, SAM_BUSINESS),
      placed("pick-sam-plumbing", 1, SAM_COMPANY, SAM_BUSINESS),
      placed("pick-sam-electrical", 1, SAM_COMPANY, SAM_BUSINESS),
      ...textsGiven("pick-sam-barbershop", SAM_BUSINESS),
    ]);
    expect(rows.state.filter((write) => write.table === "companies")).toEqual([]);
    expect(rows.state.filter((write) => write.op === "insert" && write.values.kind_id === "barber")).toEqual(
      [],
    );
  });

  it("a company name the owner gives updates the company under way at its version, always, even to its stored name", async () => {
    const [company] = samCompanies();
    if (company === undefined) throw new Error("Sam owns the company of Lee's Barbershop");
    const unnamed = (await written(samWorld(), samAnswer(ALL))).rows.state;
    for (const name of ["Lee Services", company.name]) {
      const answer = samAnswer(ALL, [named(name)]);
      const { rows } = await written(samWorld(), answer);
      const [rename, ...rest] = rows.state;
      expect(rename).toEqual({
        op: "update",
        table: "companies",
        key: { id: SAM_COMPANY },
        expectVersion: company.version,
        set: { name },
      });
      expect(rest).toEqual(unnamed);
      expect(await s1_04RuleProblems(answer, rows.state)).toEqual([]);
      // Left out, as round 1 left it out for an equal name, K-09 refuses the rows (default 183).
      expect(await s1_04RuleProblems(answer, rest)).toEqual([
        `the company the turn runs under, ${SAM_COMPANY}, alone is updated, with the name the owner gave`,
      ]);
    }
    expect(company.name).toBe("Lee's Barbershop LLC");
  });

  it("the company's name is company_name's value, not its source words, where the two differ", async () => {
    const fields = [{ name: COMPANY_NAME, value: "Lee Home Services", words: "lee home services llc" }];
    const all = samAnswer(ALL, fields);
    const { rows } = await written(samWorld(), all);
    expect(rows.state[0]).toEqual({
      op: "update",
      table: "companies",
      key: { id: SAM_COMPANY },
      expectVersion: 2,
      set: { name: "Lee Home Services" },
    });
    expect(await s1_04RuleProblems(all, rows.state)).toEqual([]);
    // Under "Some share one" (the flag on) the new company of the shared group takes the value too.
    const some = samAnswer(SOME, [shared("Plumbing and electrical"), ...fields]);
    const made = await written(samWorld(), some, "sam", true);
    expect(made.rows.state).toEqual(s1_04Exchange(COMMIT_S1_04_SOME_SHARE).given.stated.writes.state);
    expect(made.rows.state[0]).toEqual(newCompany("company-s1-04-sam-1", "Lee Home Services"));
    expect(await s1_04RuleProblems(some, made.rows.state)).toEqual([]);
    expect(JSON.stringify([rows.state, made.rows.state])).not.toContain("llc");
  });

  it("a company_name whose value is blank or no text counts as not given: the company keeps its stored name", async () => {
    const unnamed = (await written(samWorld(), samAnswer(ALL))).rows.state;
    for (const value of [" ", 7]) {
      const field = { name: COMPANY_NAME, value, words: "Lee Home Services" } as unknown as AnswerField;
      expect((await written(samWorld(), samAnswer(ALL, [field]))).rows.state).toEqual(unnamed);
    }
  });

  it("'Some share one' naming every kept pick is one company, saved with the flag off", async () => {
    const answer = samAnswer(SOME, [shared("Barbershop, plumbing and electrical"), named("Lee Services")]);
    const { rows } = await written(samWorld(), answer);
    expect(rows.state).toEqual(
      (await written(samWorld(), samAnswer(ALL, [named("Lee Services")]))).rows.state,
    );
  });
});

describe("with the party flag on: Sam's own answer, and 'Each is its own'", () => {
  it("Sam's 'Some share one' gives commit-s1-04-some-share.json's state rows, field for field", async () => {
    const exchange = s1_04Exchange(COMMIT_S1_04_SOME_SHARE);
    const { rows, asked } = await written(samWorld(), exchange, "sam", true);
    expect(rows.state).toEqual(exchange.given.stated.writes.state);
    expect(await s1_04RuleProblems(exchange, rows.state)).toEqual([]);
    expect(rows.gives).toEqual([COMPANIES]);
    expect(rows.stateEvents).toEqual([]);
    // The kinds' names by id (default 190's matching), then item 72, then the catalog for each company kind inserted.
    expect(readsOf(asked)).toEqual([
      "readPickedKinds",
      "readTurnState",
      "readBusinessKinds",
      "readTurnState",
      "readTurnState",
    ]);
    expect(asked[1]).toEqual({
      read: "readTurnState",
      repo: { name: "walk-test-repo" },
      request: {
        handleId: "handle-sam",
        businessId: SAM_BUSINESS,
        bookingIds: [],
        facts: ["barber", "plumber", "electrician"].map((kindId) => ({
          key: "kind.name",
          table: "kinds",
          rowId: kindId,
          column: "name",
        })),
      },
    });
  });

  it("'Each is its own' gives three companies: the turn's for the first kind named, two new ones with no business", async () => {
    const { rows, asked } = await written(samWorld(), samAnswer(EACH), "sam", true);
    expect(await s1_04RuleProblems(samAnswer(EACH), rows.state)).toEqual([]);
    expect(rows.state).toEqual([
      newCompany("company-s1-04-sam-1", "plumbing"),
      newCompany("company-s1-04-sam-2", "electrical"),
      kindOf("company-s1-04-sam-1", null, "plumber"),
      kindOf("company-s1-04-sam-2", null, "electrician"),
      placed("pick-sam-barbershop", 1, SAM_COMPANY, SAM_BUSINESS),
      placed("pick-sam-plumbing", 1, "company-s1-04-sam-1"),
      placed("pick-sam-electrical", 1, "company-s1-04-sam-2"),
      ...textsGiven("pick-sam-barbershop", SAM_BUSINESS),
    ]);
    const companies = new Set(
      rows.state.flatMap((write) =>
        write.op === "update" && write.table === "picked_kinds" ? [write.set.company_id] : [],
      ),
    );
    expect(companies).toEqual(new Set([SAM_COMPANY, "company-s1-04-sam-1", "company-s1-04-sam-2"]));
    // No field is read under "Each is its own", so no kind's name either.
    expect(readsOf(asked)).toEqual([
      "readPickedKinds",
      "readBusinessKinds",
      "readTurnState",
      "readTurnState",
    ]);
  });

  it("'Some share one' with no company name names the new company by its first kind's own words", async () => {
    const { rows } = await written(
      samWorld(),
      samAnswer(SOME, [shared("Plumbing and electrical")]),
      "sam",
      true,
    );
    expect(rows.state[0]).toEqual(newCompany("company-s1-04-sam-1", "plumbing"));
  });

  it("a shared word meets a kind's name when the owner's own words differ ('plumber and electrician')", async () => {
    const picks = samPicks().map((pick) =>
      pick.kindId === "plumber"
        ? { ...pick, words: "pipes" }
        : pick.kindId === "electrician"
          ? { ...pick, words: "wiring" }
          : pick,
    );
    const answer = samAnswer(SOME, [shared("plumber and electrician"), named("Lee Home Services")]);
    const { rows } = await written(samWorld({ picks }), answer, "sam", true);
    expect(rows.state).toEqual(s1_04Exchange(COMMIT_S1_04_SOME_SHARE).given.stated.writes.state);
  });
});

describe("with the party flag off, any answer that needs a second company is refused, nothing returned", () => {
  it.each([
    [
      "Sam's own 'Some share one'",
      () => s1_04Exchange(COMMIT_S1_04_SOME_SHARE),
      ["readPickedKinds", "readTurnState"],
    ],
    ["'Each is its own'", () => samAnswer(EACH), ["readPickedKinds"]],
  ] as const)("%s: secondCompany, before item 72 or the catalog is read", async (_, answer, reads) => {
    for (const flag of [undefined, false]) {
      const { thrown, asked } = await refused(samWorld(), answer(), flag);
      expect(faultOf(thrown)).toBe("secondCompany");
      expect((thrown as CompaniesRefusedError).ids).toEqual(["S1-04"]);
      expect(readsOf(asked)).toEqual(reads);
    }
  });
});

describe("which picks are placed, and which rows take the business", () => {
  /** Sam's barbershop and plumbing picks, each with its blocks, and a drafted pick with its draft and two blocks. */
  function draftedWorld(): CompaniesGiven {
    const [barbershop, plumbing] = samPicks();
    if (barbershop === undefined || plumbing === undefined) throw new Error("Sam has three picks");
    const hikes = pickOnFile({
      id: "pick-sam-hikes",
      position: 3,
      words: "pack hikes",
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
            rowId: "draft-sam-hikes/3",
            block: 3,
            businessId: null,
            outcome: "answered",
            factsOn: ["photos"],
            switchesOn: ["cancelright"],
            answeredAt: "2026-10-19T14:02:00Z",
            version: 1,
          },
        ],
      },
    });
    return { picks: [barbershop, { ...plumbing, texts: textsOf("pick-sam-plumbing") }, hikes] };
  }

  it("text rows, a draft and its blocks take the business only where the pick's company has one", async () => {
    const { rows } = await written(draftedWorld(), samAnswer(EACH), "sam", true);
    const touched = rows.state.flatMap((write) =>
      write.op === "update" && write.table !== "picked_kinds" ? [write.table] : [],
    );
    // The barbershop lands in the turn's company: its 11 blocks gain the business. Plumbing and the drafted kind land
    // in new companies with no business, so their blocks, draft and draft blocks keep none.
    expect(touched).toEqual(PF_TEXT_KEYS.map(() => "picked_kind_texts"));
    expect(rows.state.slice(-11)).toEqual(textsGiven("pick-sam-barbershop", SAM_BUSINESS));
    // The drafted kind's company kind under its new company: the protective facts and its answered block's (default 182).
    const [, , hikes] = draftedWorld().picks ?? [];
    expect(rows.state).toContainEqual(
      companyKindInsert(
        "company-s1-04-sam-2",
        null,
        "new-0123456789abcdef",
        draftedDefaults(hikes?.draft ?? null),
      ),
    );
    expect(draftedDefaults(hikes?.draft ?? null)).toEqual({
      facts: ["documents", "forms", "photos"],
      switchesA: ["cancelright"],
      switchesB: ["cancelright"],
    });
  });

  it("all in the turn's company: every kept pick's blocks, the draft and its blocks take the business", async () => {
    const { rows } = await written(draftedWorld(), samAnswer(ALL));
    expect(rows.state).toEqual([
      kindOf(SAM_COMPANY, SAM_BUSINESS, "plumber"),
      companyKindInsert(SAM_COMPANY, SAM_BUSINESS, "new-0123456789abcdef", {
        facts: ["documents", "forms", "photos"],
        switchesA: ["cancelright"],
        switchesB: ["cancelright"],
      }),
      placed("pick-sam-barbershop", 1, SAM_COMPANY, SAM_BUSINESS),
      placed("pick-sam-plumbing", 1, SAM_COMPANY, SAM_BUSINESS),
      placed("pick-sam-hikes", 2, SAM_COMPANY, SAM_BUSINESS),
      ...textsGiven("pick-sam-barbershop", SAM_BUSINESS),
      ...textsGiven("pick-sam-plumbing", SAM_BUSINESS),
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
        key: { draft_id: "draft-sam-hikes", block: 3 },
        expectVersion: 1,
        set: { business_id: SAM_BUSINESS },
      },
    ]);
  });

  it("two drafted picks gaining a business: every text row, then both drafts, then the first's answered block", async () => {
    const walks = pickOnFile({
      id: "pick-sam-walks",
      position: 4,
      words: "dog walks",
      outcome: "new_work",
      kindId: "new-fedcba9876543210",
      draft: {
        id: "draft-sam-walks",
        businessId: null,
        state: "drafting",
        draftedAt: "2026-10-19T14:03:00Z",
        version: 1,
        blocks: [],
      },
    });
    const world = draftedWorld();
    const answer = samAnswer(ALL);
    const { rows } = await written({ picks: [...(world.picks ?? []), walks] }, answer);
    const draftOf = (id: string, version: number): StateWrite => ({
      op: "update",
      table: "new_work_drafts",
      key: { id },
      expectVersion: version,
      set: { business_id: SAM_BUSINESS },
    });
    expect(rows.state.slice(-25)).toEqual([
      ...textsGiven("pick-sam-barbershop", SAM_BUSINESS),
      ...textsGiven("pick-sam-plumbing", SAM_BUSINESS),
      draftOf("draft-sam-hikes", 4),
      draftOf("draft-sam-walks", 1),
      {
        op: "update",
        table: "new_work_draft_blocks",
        key: { draft_id: "draft-sam-hikes", block: 3 },
        expectVersion: 1,
        set: { business_id: SAM_BUSINESS },
      },
    ]);
    // Table by table, in K-09's S1_04_WRITE_ORDER: each table's rows together, never one pick's after another's.
    const tables = rows.state.map((write) => write.table);
    expect([...new Set(tables)]).toEqual([
      "company_kinds",
      "picked_kinds",
      "picked_kind_texts",
      "new_work_drafts",
      "new_work_draft_blocks",
    ]);
    expect(tables.filter((table, at) => at > 0 && table !== tables[at - 1])).toHaveLength(4);
    expect(await s1_04RuleProblems(answer, rows.state)).toEqual([]);
    // One pick's rows after another's (draft, block, draft), as round 1 strung them, K-09 refuses as out of order.
    const strung = [...rows.state.slice(0, -2), ...rows.state.slice(-1), ...rows.state.slice(-2, -1)];
    expect(await s1_04RuleProblems(answer, strung)).toEqual([
      "S1-04's rows are out of foreign-key order: companies, company_kinds, picked_kinds, then the rows of a pick that gained a business",
    ]);
  });

  it("a not_booked pick is never placed, and another person's pick under the business is left out", async () => {
    const giftCards = pickOnFile({
      id: "pick-sam-gift-cards",
      position: 4,
      words: "Gift cards",
      outcome: "not_booked",
      kindId: null,
    });
    const alex = pickOnFile({
      id: "pick-alex-plumbing",
      ownerPersonId: "person-alex",
      businessId: SAM_BUSINESS,
    });
    const { rows } = await written(samWorld({ picks: [...samPicks(), giftCards, alex] }), samAnswer(ALL));
    expect(rows.state).toEqual((await written(samWorld(), samAnswer(ALL))).rows.state);
    expect(JSON.stringify(rows.state)).not.toContain("pick-sam-gift-cards");
    expect(JSON.stringify(rows.state)).not.toContain("pick-alex-plumbing");
  });

  it("the first kind named is the lowest position, whatever item 79's order: its group takes the turn's company", async () => {
    const [barbershop, plumbing, electrical] = samPicks();
    if (barbershop === undefined || plumbing === undefined || electrical === undefined) {
      throw new Error("Sam has three picks");
    }
    const { rows } = await written(
      samWorld({ picks: [electrical, plumbing, barbershop] }),
      samAnswer(EACH),
      "sam",
      true,
    );
    expect(rows.state.slice(0, 2)).toEqual([
      newCompany("company-s1-04-sam-1", "plumbing"),
      newCompany("company-s1-04-sam-2", "electrical"),
    ]);
    expect(rows.state).toContainEqual(placed("pick-sam-barbershop", 1, SAM_COMPANY, SAM_BUSINESS));
  });
});

describe("each refusal: nothing returned", () => {
  it("sharedWordNoPick: a shared word names no kept pick ('Plumbing and roofing')", async () => {
    const answer = samAnswer(SOME, [shared("Plumbing and roofing")]);
    expect(faultOf((await refused(samWorld(), answer, true)).thrown)).toBe("sharedWordNoPick");
  });

  it("sharedWordTwoPicks: a shared word names two kept picks (a drafted kind's own words meet it too)", async () => {
    const gates = pickOnFile({
      id: "pick-sam-gates",
      position: 4,
      words: "electrical gates",
      outcome: "new_work",
      kindId: "new-fedcba9876543210",
    });
    const answer = samAnswer(SOME, [shared("Barbershop and electrical")]);
    const { thrown } = await refused(samWorld({ picks: [...samPicks(), gates] }), answer, true);
    expect(faultOf(thrown)).toBe("sharedWordTwoPicks");
  });

  it("sharedGroupTooSmall: the words name one pick alone", async () => {
    const answer = samAnswer(SOME, [shared("plumbing, plumber")]);
    expect(faultOf((await refused(samWorld(), answer, true)).thrown)).toBe("sharedGroupTooSmall");
  });

  it("noSharedKinds: 'Some share one' with no shared_kinds, or with no word left to match", async () => {
    for (const fields of [[], [named("Lee Home Services")], [shared("and the")]]) {
      const { thrown, asked } = await refused(samWorld(), samAnswer(SOME, fields), true);
      expect(faultOf(thrown)).toBe("noSharedKinds");
      expect(readsOf(asked).filter((read) => read !== "readPickedKinds" && read !== "readTurnState")).toEqual(
        [],
      );
    }
  });

  it("secondSharedGroup: shared_kinds or company_name given twice, refused before anything is read", async () => {
    const twice = [
      samAnswer(SOME, [shared("Plumbing and electrical"), shared("Barbershop and nails")]),
      samAnswer(SOME, [shared("Plumbing and electrical"), named("Lee Home Services"), named("Lee Beauty")]),
      samAnswer(ALL, [named("Lee Home Services"), named("Lee Beauty")]),
    ];
    for (const answer of twice) {
      const { thrown, asked } = await refused(samWorld(), answer, true);
      expect(faultOf(thrown)).toBe("secondSharedGroup");
      expect(asked).toEqual([]);
    }
  });

  it("twoPicksOneKind: two picks of one kind would land in one company", async () => {
    const pipes = pickOnFile({ id: "pick-sam-pipes", position: 4, words: "pipes" });
    const { thrown } = await refused(samWorld({ picks: [...samPicks(), pipes] }), samAnswer(ALL));
    expect(faultOf(thrown)).toBe("twoPicksOneKind");
  });

  it("noKeptPick: no pick, or a not_booked pick alone", async () => {
    expect(faultOf((await refused({ picks: [] }, samAnswer(ALL))).thrown)).toBe("noKeptPick");
    const giftCards = pickOnFile({ id: "pick-sam-gift-cards", outcome: "not_booked", kindId: null });
    expect(faultOf((await refused({ picks: [giftCards] }, samAnswer(ALL))).thrown)).toBe("noKeptPick");
  });

  it("noTurnCompany: the caller's person owns no company under the call's business", async () => {
    const otherOwner = samCompanies().map((company) => ({ ...company, ownerPersonId: "person-alex" }));
    for (const companies of [[], otherOwner]) {
      expect(faultOf((await refused(samWorld({ companies }), samAnswer(ALL))).thrown)).toBe("noTurnCompany");
    }
  });

  it("alreadyPlaced: a kept pick with a company, or with a business and no company (S1-04 answered again)", async () => {
    for (const over of [
      { companyId: SAM_COMPANY, businessId: SAM_BUSINESS },
      { companyId: "company-s1-04-sam-1", businessId: null },
      { companyId: null, businessId: SAM_BUSINESS },
    ]) {
      const picks = samPicks().map((pick) => (pick.kindId === "plumber" ? { ...pick, ...over } : pick));
      const { thrown, asked } = await refused(samWorld({ picks }), samAnswer(ALL));
      expect(faultOf(thrown)).toBe("alreadyPlaced");
      expect(readsOf(asked)).toEqual(["readPickedKinds"]);
    }
  });

  it("unknownBranch, wrongStep and noPerson", async () => {
    const answer = samAnswer(ALL);
    const writer = writerOver(samWorld()).write;
    const call = s1_04CallOf(answer.request, "sam");
    const unknown = await writer({ ...call, choice: { ...call.choice, branch: "Most share one" } }).catch(
      (error: unknown) => error,
    );
    expect(faultOf(unknown)).toBe("unknownBranch");
    const atS1_08 = await writer(s1_04CallOf(answer.request, "sam", graphStep("S1-08"))).catch(
      (error: unknown) => error,
    );
    expect(faultOf(atS1_08)).toBe("wrongStep");
    expect((atS1_08 as CompaniesRefusedError).ids).toEqual(["S1-04", "S1-08"]);
    const caller = answer.request.caller as { personId: string | null };
    caller.personId = null;
    const nobody = await writer(s1_04CallOf(answer.request, "sam")).catch((error: unknown) => error);
    expect(faultOf(nobody)).toBe("noPerson");
  });

  it("a refusal's message names the fault and the step, never the owner's words", async () => {
    const answer = samAnswer(SOME, [shared("Plumbing and roofing"), named("Lee Home Services")]);
    const { thrown } = await refused(samWorld(), answer, true);
    const message = (thrown as Error).message;
    expect(message).toContain("sharedWordNoPick");
    expect(message).not.toMatch(/roofing|Lee Home Services|pick-sam/u);
  });
});

describe("a failed read rejects, never read as none", () => {
  it("item 79: transient or notFound, or a throw", async () => {
    const transient = await refused({ picked: { error: "transient", sqlstate: "40001" } }, samAnswer(ALL));
    expect(readFaultOf(transient.thrown)).toEqual(["readPickedKinds", "transient"]);
    const notFound = await refused(
      { picked: { error: "notFound", table: "persons", rowId: SAM_PERSON } },
      samAnswer(ALL),
    );
    expect(readFaultOf(notFound.thrown)).toEqual(["readPickedKinds", "notFound"]);
    const lost = new Error("connection lost");
    expect((await refused({ throws: { read: "readPickedKinds", error: lost } }, samAnswer(ALL))).thrown).toBe(
      lost,
    );
  });

  it("item 72: notFound or transient, or a throw", async () => {
    const notFound = await refused(
      samWorld({ businessKinds: { error: "notFound", table: "businesses", rowId: SAM_BUSINESS } }),
      samAnswer(ALL),
    );
    expect(readFaultOf(notFound.thrown)).toEqual(["readBusinessKinds", "notFound"]);
    const transient = await refused(
      samWorld({ businessKinds: { error: "transient", sqlstate: "40P01" } }),
      samAnswer(ALL),
    );
    expect(readFaultOf(transient.thrown)).toEqual(["readBusinessKinds", "transient"]);
    const lost = new Error("connection lost");
    const thrown = await refused(
      samWorld({ throws: { read: "readBusinessKinds", error: lost } }),
      samAnswer(ALL),
    );
    expect(thrown.thrown).toBe(lost);
  });

  it("the catalog by id (a kind's facts and switches, or its name): notFound, transient, or a throw", async () => {
    const facts = await refused(
      samWorld({ turnState: { error: "notFound", table: "kind_flows", rowId: "plumber/B" } }),
      samAnswer(ALL),
    );
    expect(readFaultOf(facts.thrown)).toEqual(["readTurnState", "notFound"]);
    const names = await refused(
      samWorld({ turnState: { error: "transient", sqlstate: "40001" } }),
      samAnswer(SOME, [shared("Plumbing and electrical")]),
      true,
    );
    expect(readFaultOf(names.thrown)).toEqual(["readTurnState", "transient"]);
    expect(readsOf(names.asked)).toEqual(["readPickedKinds", "readTurnState"]);
    const lost = new Error("connection lost");
    const thrown = await refused(
      samWorld({ throws: { read: "readTurnState", error: lost } }),
      samAnswer(ALL),
    );
    expect(thrown.thrown).toBe(lost);
  });

  it("a kind's name that is no text, or answered twice, is refused (notWellFormed)", async () => {
    for (const twist of ["number", "blank", "twice"] as const) {
      const fake = fakeCompaniesK05(samWorld());
      const reads = companiesReadsOf({
        ...fake.k05,
        async readTurnState(repo, request) {
          const answer = await fake.k05.readTurnState(repo, request);
          if ("error" in answer) return answer;
          const facts = answer.facts.map((fact) => ({
            ...fact,
            value: twist === "number" ? 7 : twist === "blank" ? " " : fact.value,
          }));
          return { ...answer, facts: twist === "twice" ? [...facts, ...facts] : facts };
        },
      });
      const write = companiesWriter<WalkTestRepo>({ reads, partyRuleLive: true });
      const answer = samAnswer(SOME, [shared("Plumbing and electrical")]);
      const thrown = await write(s1_04CallOf(answer.request, "sam")).catch((error: unknown) => error);
      expect(readFaultOf(thrown)).toEqual(["readTurnState", "notWellFormed"]);
    }
  });
});
