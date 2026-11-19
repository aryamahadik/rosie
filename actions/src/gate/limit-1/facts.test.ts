// T-1467's unit proofs (DL-982, the architect's ruling on T-1463's handoff 1): the shipped limit's one rule,
// contactsOnFileIn (facts.ts), and createLimit1's default for it (index.ts), over a database double that answers the three
// statements db/repo/sign-up-reads.ts readSignUpFactsIn sends (the scope, the role's side, the one read), never a double
// of the one rule or of that read:
//   - its two refusals read nothing: a call that is no turn, a turn with no handle and a business standing answer false,
//     with no statement made;
//   - as a customer it answers readSignUpFactsIn's link of the ask's own business, handle and person, under the call's
//     scope: through 0038's person_handles_linked for a role that may not select person_handles (rosie_app), with no
//     statement on handles, persons, phones, person_handles or turns, and on person_handles directly for one that may
//     (rosie_job);
//   - every error is thrown as the read throws it, never answered: a scope that is not the call's (BusinessScopeError)
//     before the read, a refused statement (42501) as it is;
//   - the shipped limit 1 proves a sender through it on the call's transaction, never through T-308's sender(), while a
//     limit given an identity service (the tests' doubles) reads that service's sender(), as before.
// Ids are K-04's seeds' and the scenarios' own (test-support.ts); no number, no network and no database (the real reads
// are pg/sign-up.int.test.ts's).

import { describe, expect, it } from "vitest";

import { BusinessScopeError, type Sql } from "../../../../db/repo/scope";
import { CALLER_KINDS } from "../../tool-api/calls";
import type { GateRequest } from "../framework";
import {
  contactsOnFileIn,
  createLimit1,
  limit1,
  type AllowedDecision,
  type AllowedLimit,
  type OwnAsk,
  type ProofStanding,
} from "./index";
import {
  ALEX,
  ALEX_NEW_MOBILE,
  BARBERSHOP,
  HOME_SERVICES,
  contactChange,
  identityFrom,
  limitRecord,
  partOf,
  requestFor,
  stagesFrom,
  stepsOf,
  turnOf,
  type Someone,
} from "./test-support";

/** One statement or fragment as the double was handed it: its words with each value as $?, and its values. */
interface Statement {
  readonly text: string;
  readonly values: readonly unknown[];
}

type Rows = readonly Record<string, unknown>[];

/** Which of readSignUpFactsIn's three statements: the scope, the role's side, the one read. */
type Step = "scope" | "side" | "read";

/** What the double's database answers readSignUpFactsIn with. */
interface DbWorld {
  /** The transaction's business scope, current_setting('rosie.business_id', true): null for none. */
  readonly scope: string | null;
  /** Whether the transaction's role may select from person_handles: the runtime side's (rosie_job), not rosie_app's. */
  readonly readsLinks: boolean;
  /** What the one read answers for the link (0038's answer, or exists() on person_handles). */
  readonly linked: boolean;
  /** The statement PostgreSQL refuses (42501), as a refused statement fails. */
  readonly refused?: Step;
}

interface DbDouble {
  /** The handle the reader takes: a tagged template, as postgres.js's transaction is. */
  readonly db: Sql;
  /** Every statement and fragment made, in order, whether or not it was sent. */
  readonly made: Statement[];
  /** Every statement sent: awaited, as postgres.js sends one (a fragment goes inside the statement that holds it). */
  readonly sent: Statement[];
}

/** The step a statement is, by its words; null for any other statement or a fragment. */
function stepOf(statement: Statement): Step | null {
  if (/^select current_setting\(\$\?, true\) as scope$/u.test(statement.text)) return "scope";
  if (/^select has_table_privilege\('person_handles', 'SELECT'\) as reads_links$/u.test(statement.text)) {
    return "side";
  }
  if (/\bleft join business_setup s on s\.business_id = \$\?$/u.test(statement.text)) return "read";
  return null;
}

/** A refused statement, as postgres.js fails it: insufficient_privilege. */
function refusal(): Error {
  return Object.assign(new Error("permission denied"), { code: "42501" });
}

/**
 * A database double for readSignUpFactsIn: each statement or fragment is made lazily, as postgres.js makes one, and sent
 * only once awaited; the three statements are answered from `world`, and any other statement sent fails.
 */
function dbOf(world: DbWorld): DbDouble {
  const made: Statement[] = [];
  const sent: Statement[] = [];
  const answers: Readonly<Record<Step, Rows>> = {
    scope: [{ scope: world.scope }],
    side: [{ reads_links: world.readsLinks }],
    read: [{ control_proven_at: null, version: 1, linked: world.linked }],
  };
  const send = (statement: Statement): Promise<Rows> => {
    sent.push(statement);
    const step = stepOf(statement);
    if (step === null) return Promise.reject(new Error("the double answers no other statement"));
    return world.refused === step ? Promise.reject(refusal()) : Promise.resolve(answers[step]);
  };
  const db = (strings: TemplateStringsArray, ...values: unknown[]): Statement & PromiseLike<Rows> => {
    const statement: Statement = { text: strings.join("$?").replace(/\s+/gu, " ").trim(), values };
    made.push(statement);
    return {
      ...statement,
      then<A = Rows, B = never>(
        onfulfilled?: ((rows: Rows) => A | PromiseLike<A>) | null,
        onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
      ): PromiseLike<A | B> {
        return send(statement).then(onfulfilled, onrejected);
      },
    };
  };
  return { db: db as unknown as Sql, made, sent };
}

/** The fragments made and never sent on their own: the one read's link. */
function fragmentsOf(double: DbDouble): Statement[] {
  return double.made.filter((statement) => !double.sent.includes(statement));
}

/** A statement that reads a table that spans businesses (sign-up.int.test.ts's pattern). */
const SPANS_BUSINESSES = /\b(from|join)\s+(handles|persons|phones|person_handles|turns)\b/u;

/** The scoped transaction of the barbershop as rosie_app, answering `linked` for the link. */
const asApp = (linked: boolean): DbWorld => ({ scope: BARBERSHOP, readsLinks: false, linked });

/** Alex's own question to the one rule: in a turn on his own phone, at the barbershop, as a customer. */
const ALEX_OWN: OwnAsk = {
  businessId: BARBERSHOP,
  personId: "person-alex",
  as: "self",
  caller: "turn",
  handleId: ALEX.handleId,
};

/** `who`'s contact-change row (their own record, S13-45 row 3), in a turn or from another caller. */
function contactChangeFrom(who: Someone, caller?: "page" | "agent"): GateRequest {
  const choice = contactChange();
  return requestFor({
    who,
    choices: [choice],
    choiceId: choice.choiceId,
    words: "send updates to my email",
    ...(caller === undefined ? {} : { caller }),
  });
}

describe("T-1467: the one rule's two refusals read nothing (contactsOnFileIn)", () => {
  it("a call that is no turn (a page, an AI, the console, a job, a clock, the actor) answers false, with no statement made", async () => {
    const off = CALLER_KINDS.filter((kind) => kind !== "turn");
    expect(off.length).toBeGreaterThan(0);
    for (const caller of off) {
      const double = dbOf(asApp(true));
      expect(await contactsOnFileIn(double.db).isOwn({ ...ALEX_OWN, caller }), caller).toBe(false);
      expect(double.made, caller).toEqual([]);
    }
  });

  it("a turn with no handle answers false, with no statement made", async () => {
    const double = dbOf(asApp(true));
    expect(await contactsOnFileIn(double.db).isOwn({ ...ALEX_OWN, handleId: null })).toBe(false);
    expect(double.made).toEqual([]);
  });

  it("a business standing (owner, admin, staff), whose own mobile or email on file has no reader yet, answers false, with no statement made", async () => {
    const standings: readonly ProofStanding[] = ["owner", "admin", "staff"];
    for (const as of standings) {
      const double = dbOf(asApp(true));
      expect(await contactsOnFileIn(double.db).isOwn({ ...ALEX_OWN, as }), as).toBe(false);
      expect(double.made, as).toEqual([]);
    }
  });
});

describe("T-1467: as a customer, the one rule answers readSignUpFactsIn's link of the ask's own business, handle and person", () => {
  it("as rosie_app: under the call's scope, the link through 0038's person_handles_linked with the ask's person and handle, and no statement on a table that spans businesses", async () => {
    for (const linked of [true, false]) {
      const double = dbOf(asApp(linked));
      expect(await contactsOnFileIn(double.db).isOwn(ALEX_OWN), String(linked)).toBe(linked);
      expect(double.sent.map(stepOf)).toEqual(["scope", "side", "read"]);
      const [, , read] = double.sent;
      expect(read?.values[1]).toBe(BARBERSHOP);
      const fragments = fragmentsOf(double);
      expect(fragments).toEqual([
        { text: "person_handles_linked($?, $?)", values: ["person-alex", ALEX.handleId] },
      ]);
      expect(read?.values[0]).toMatchObject({ ...fragments[0] });
      for (const statement of double.made) expect(statement.text).not.toMatch(SPANS_BUSINESSES);
    }
  });

  it("as rosie_job, the runtime side: the same three statements, the link read on person_handles directly by its key", async () => {
    for (const linked of [true, false]) {
      const double = dbOf({ scope: BARBERSHOP, readsLinks: true, linked });
      expect(await contactsOnFileIn(double.db).isOwn(ALEX_OWN), String(linked)).toBe(linked);
      expect(double.sent.map(stepOf)).toEqual(["scope", "side", "read"]);
      expect(fragmentsOf(double)).toEqual([
        {
          text: "exists (select 1 from person_handles ph where ph.person_id = $? and ph.handle_id = $?)",
          values: ["person-alex", ALEX.handleId],
        },
      ]);
    }
  });

  it("each question is the ask's own: another person, another handle and another business each reach the read as asked", async () => {
    const asks: readonly OwnAsk[] = [
      { ...ALEX_OWN, personId: "person-alex-partner" },
      { ...ALEX_OWN, handleId: ALEX_NEW_MOBILE.handleId },
      { ...ALEX_OWN, businessId: HOME_SERVICES },
    ];
    for (const ask of asks) {
      const double = dbOf({ ...asApp(true), scope: ask.businessId });
      expect(await contactsOnFileIn(double.db).isOwn(ask)).toBe(true);
      expect(fragmentsOf(double)).toEqual([
        { text: "person_handles_linked($?, $?)", values: [ask.personId, ask.handleId] },
      ]);
      expect(double.sent[2]?.values[1]).toBe(ask.businessId);
    }
  });
});

describe("T-1467: every error of the read is thrown as it is, never answered", () => {
  it("a transaction with no scope, or another business's, is refused (BusinessScopeError) before the read: nothing after the scope is sent", async () => {
    for (const scope of [null, HOME_SERVICES]) {
      const double = dbOf({ ...asApp(true), scope });
      await expect(contactsOnFileIn(double.db).isOwn(ALEX_OWN), String(scope)).rejects.toBeInstanceOf(
        BusinessScopeError,
      );
      expect(double.sent.map(stepOf), String(scope)).toEqual(["scope"]);
    }
  });

  it("a refused statement fails the question with its own error (42501), whichever statement it is", async () => {
    for (const refused of ["scope", "side", "read"] as const) {
      const double = dbOf({ ...asApp(true), refused });
      await expect(contactsOnFileIn(double.db).isOwn(ALEX_OWN), refused).rejects.toMatchObject({
        code: "42501",
      });
    }
  });
});

describe("T-1467: createLimit1's default one rule", () => {
  /** The limit's decision on `request`'s part, the double's transaction as the call's repo. */
  const decide = (limit: AllowedLimit, request: GateRequest, double: DbDouble): Promise<AllowedDecision> =>
    limit.decide(partOf(request), turnOf(request, double.db));

  it("the shipped limit 1 proves a sender through contactsOnFileIn on the call's transaction: Alex's own record passes when 0038 answers his link, and is unproven (notBuilt, no T-322 codes) when it does not", async () => {
    const linked = dbOf(asApp(true));
    expect(await decide(limit1, contactChangeFrom(ALEX), linked)).toEqual({ result: "pass", why: "decider" });
    expect(linked.sent.map(stepOf)).toEqual(["scope", "side", "read"]);
    expect(fragmentsOf(linked)).toEqual([
      { text: "person_handles_linked($?, $?)", values: ["person-alex", ALEX.handleId] },
    ]);
    // Never T-308's sender(): no statement reads the handle's people (db/repo/phones.ts listPersonIdsOfHandle).
    for (const statement of linked.made) expect(statement.text).not.toMatch(SPANS_BUSINESSES);

    const unlinked = dbOf(asApp(false));
    expect(await decide(limit1, contactChangeFrom(ALEX_NEW_MOBILE), unlinked)).toEqual({
      result: "notBuilt",
      port: "proofCodes",
    });
    expect(fragmentsOf(unlinked)).toEqual([
      { text: "person_handles_linked($?, $?)", values: ["person-alex", ALEX_NEW_MOBILE.handleId] },
    ]);
  });

  it("off the chat the shipped one rule reads nothing: Alex's own change from a page or an AI is a question in his own chat, as before", async () => {
    for (const caller of ["page", "agent"] as const) {
      const double = dbOf(asApp(true));
      expect(await decide(limit1, contactChangeFrom(ALEX, caller), double), caller).toMatchObject({
        result: "fail",
        why: "unproven",
        next: { kind: "askDecider", deciders: ["person-alex"], matters: [{ kind: "own" }] },
      });
      expect(double.made, caller).toEqual([]);
    }
  });

  it("a limit given an identity service (the tests' doubles) still proves a sender through that service's sender(), with nothing read on the call's transaction", async () => {
    const record = limitRecord();
    const limit = createLimit1({
      identity: identityFrom(record),
      stages: stagesFrom(record),
      steps: stepsOf(),
    });
    const own = dbOf(asApp(false));
    expect(await decide(limit, contactChangeFrom(ALEX), own)).toEqual({ result: "pass", why: "decider" });
    expect(own.made).toEqual([]);
    const notOnFile = dbOf(asApp(true));
    expect(await decide(limit, contactChangeFrom(ALEX_NEW_MOBILE), notOnFile)).toEqual({
      result: "notBuilt",
      port: "proofCodes",
    });
    expect(notOnFile.made).toEqual([]);
  });
});
