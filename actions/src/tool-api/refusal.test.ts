// T-1551's proofs for refusal.ts (T-1529's ruling 1; K-09 v1.13 README defaults 216 and 217):
//   - every fault of every one of the six fault lists, read from the list's own union in its own file, is classed final
//     or transient exactly as the ruling lists it, so a fault added to a list with no class in the ruling's list fails
//     here (and its table fails typecheck);
//   - each final fault gives turnRefused {from, fault, ids}, labels only, which K-09 v1.13's turnRefusedError and
//     gateAndCommit.errors and K-05 v1.23's parkReason accept; each transient fault, and any throw of another list, gives
//     none, so the base throws it as today; the schema's own `not` refuses each transient fault the table holds;
//   - the ids are the error's own, in their order, each once, only those that are labels (a read's: its name), and
//     nothing else of the error (its message, a read's K-05 answer) reaches the answer.
// Values are labels and made-up ids only (rule 9); a would-be number is a fiction 555-01xx one.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { CommitNotBuiltError, CommitRefusedError, type CommitFault } from "../commit/errors";
import { WalkNotBuiltError, WalkRefusedError, type WalkFault } from "../commit/walk/errors";
import { NotBuiltError, ToolApiContractError, type RefusalFrom, type TurnRefusal } from "./errors";
import {
  CompaniesReadError,
  CompaniesRefusedError,
  type CompaniesFault,
  type CompaniesReadFault,
} from "./journey-1/companies/errors";
import {
  KindsNotBuiltError,
  KindsReadError,
  KindsRefusedError,
  type KindsFault,
  type KindsReadFault,
} from "./journey-1/kinds/errors";
import { ListingRefusedError } from "./journey-1/listing/errors";
import { PlugInRefusedError } from "./journey-1/plug-ins/errors";
import {
  FAULT_CLASSES,
  REFUSAL_FROMS,
  faultClassOf,
  refusalIdsOf,
  turnRefusalOf,
  type FaultRule,
} from "./refusal";
import { AJV_OPTIONS, CONTRACTS_DIR } from "./validator";

// ---- the ruling's lists, word for word (README v1.13 default 217) -----------------------------------------------------

interface RulingList {
  /** The file that declares the list's fault union, relative to this test. */
  readonly file: string;
  /** The union's name in that file. */
  readonly type: string;
  readonly final: readonly string[];
  readonly transient: readonly string[];
  /** kinds' reviewRefused: transient when its ids carry openReviewItem's transient, final otherwise. */
  readonly byIds: readonly string[];
}

const RULING: Readonly<Record<RefusalFrom, RulingList>> = {
  walk: {
    file: "../commit/walk/errors.ts",
    type: "WalkFault",
    transient: ["questionNotLive"],
    final: [
      "flowNotInBundle",
      "stepNotInBundle",
      "branchNotInBundle",
      "pathNotInBundle",
      "stepNotWellFormed",
      "loop",
      "walkTooLong",
      "notDecided",
      "businessNotInScope",
      "noServiceOrChatId",
      "noTurnKey",
      "givesNotStep",
      "settledNotInBundle",
      "settledNotRows",
      "rowNotStep",
      "eventKeyAtWalk",
    ],
    byIds: [],
  },
  commit: {
    file: "../commit/errors.ts",
    type: "CommitFault",
    transient: ["wrongState", "stillChanged"],
    final: [
      "callerNotTurn",
      "turnIdMismatch",
      "traceIdMismatch",
      "stateTable",
      "outboxRowWithPlan",
      "effectWithoutKey",
      "effectKeyTwice",
      "effectNotWellFormed",
      "idTwice",
      "askAgainNotAlone",
      "noTurnKey",
      "partNotGated",
    ],
    byIds: [],
  },
  companies: {
    file: "./journey-1/companies/errors.ts",
    type: "CompaniesFault",
    transient: [],
    final: [
      "wrongStep",
      "noPerson",
      "pickNotWellFormed",
      "notOwnPick",
      "noKeptPick",
      "noTurnCompany",
      "twoPicksOneKind",
      "placedElsewhere",
      "notPlaced",
      "placementDisagrees",
      "draftElsewhere",
      "unknownBranch",
      "noSharedKinds",
      "secondSharedGroup",
      "sharedWordNoPick",
      "sharedWordTwoPicks",
      "sharedGroupTooSmall",
      "alreadyPlaced",
      "secondCompany",
    ],
    byIds: [],
  },
  kinds: {
    file: "./journey-1/kinds/errors.ts",
    type: "KindsFault",
    transient: [],
    final: [
      "wrongStep",
      "noBranch",
      "noWords",
      "noPerson",
      "branchNotWords",
      "notBookedBesideKept",
      "notAnswered",
      "reviewWrites",
    ],
    byIds: ["reviewRefused"],
  },
  kindsRead: {
    file: "./journey-1/kinds/errors.ts",
    type: "KindsReadFault",
    transient: ["transient"],
    final: ["notFound", "noCatalog"],
    byIds: [],
  },
  companiesRead: {
    file: "./journey-1/companies/errors.ts",
    type: "CompaniesReadFault",
    transient: ["transient"],
    final: ["notFound", "unknownFact", "notWellFormed"],
    byIds: [],
  },
};

/** The members of `type`, a union of string literals declared in `file`, as the file holds them, in order. */
function unionOf(file: string, type: string): string[] {
  const text = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
  const declared = new RegExp(`export type ${type} =([^;]*);`, "u").exec(text);
  if (declared === null) throw new Error(`${file} declares no ${type}`);
  const body = declared[1] ?? "";
  // Nothing but string literals and bars: a member of another form would be missed by the read below.
  expect(body.replace(/"[A-Za-z0-9]+"/gu, "").replace(/[|\s]/gu, ""), `${type}'s members`).toBe("");
  return [...body.matchAll(/"([A-Za-z0-9]+)"/gu)].map((member) => member[1] ?? "");
}

/** The ruling's rule for one fault of `list`, or undefined when the ruling's list does not name it. */
function rulingRuleOf(list: RulingList, fault: string): FaultRule | undefined {
  if (list.final.includes(fault)) return "final";
  if (list.transient.includes(fault)) return "transient";
  if (list.byIds.includes(fault)) return "transientWhenIdsCarryTransient";
  return undefined;
}

// ---- each list's error, as its code throws it --------------------------------------------------------------------------

/** A made-up person's row id: no fixture, seed or request holds it. */
const MADE_UP_ROW = "person-t1551-made-up-4b9d";
/** A SQLSTATE no id, time or hash here holds. */
const SQLSTATE = "40P01";
/** A fiction number (555-01xx), which reads as a number and so is no label. */
const FICTION_NUMBER = "15555550131";

/** The labels each list's error is made with below: two labels, a repeat, a fiction number and words. */
const IDS_GIVEN = ["S1-04", "S1-08", "S1-04", FICTION_NUMBER, "Sam Lee"] as const;
/** What turnRefused keeps of IDS_GIVEN: each label once, in order. */
const IDS_KEPT = ["S1-04", "S1-08"];

/** The read each read error is made with, and so the one id its turnRefused names. */
const READ_OF: Readonly<Record<"kindsRead" | "companiesRead", string>> = {
  kindsRead: "readPickedKinds",
  companiesRead: "readTurnState",
};

/** An error of the list `from` with `fault`: the list's own class, as its code throws it. */
function errorOf(from: RefusalFrom, fault: string, ids: readonly string[] = IDS_GIVEN): Error {
  switch (from) {
    case "walk":
      return new WalkRefusedError(fault as WalkFault, ids);
    case "commit":
      return new CommitRefusedError(fault as CommitFault, ids);
    case "companies":
      return new CompaniesRefusedError(fault as CompaniesFault, ids);
    case "kinds":
      return new KindsRefusedError(fault as KindsFault, ids);
    case "kindsRead":
      return new KindsReadError("readPickedKinds", fault as KindsReadFault, {
        error: "notFound",
        table: "persons",
        rowId: MADE_UP_ROW,
      });
    case "companiesRead":
      return new CompaniesReadError("readTurnState", fault as CompaniesReadFault, {
        error: "transient",
        sqlstate: SQLSTATE,
      });
  }
}

/** The ids a final answer of the list `from` names for errorOf's error. */
function keptIdsOf(from: RefusalFrom): string[] {
  return from === "kindsRead" || from === "companiesRead" ? [READ_OF[from]] : IDS_KEPT;
}

/** Every fault of every list with its ruling rule. */
const EVERY_FAULT: readonly { from: RefusalFrom; fault: string; rule: FaultRule }[] = REFUSAL_FROMS.flatMap(
  (from) => Object.entries(FAULT_CLASSES[from]).map(([fault, rule]) => ({ from, fault, rule })),
);

// ---- the frozen contracts' checks ---------------------------------------------------------------------------------------

const ID_BASE = "https://rosie.invalid/contracts/";
const K09_V1_13 = `${ID_BASE}tool-api/tool-api.v1.13.schema.json`;
const K05_V1_23 = `${ID_BASE}data-access/data-access.v1.23.schema.json`;

/** The files a schema's $refs name, relative to contracts/. */
function refsOf(file: string, schema: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (typeof value === "object" && value !== null) {
      for (const [key, inner] of Object.entries(value)) {
        if (key === "$ref" && typeof inner === "string") {
          const target = inner.split("#")[0] ?? "";
          if (target !== "") found.push(path.posix.join(path.posix.dirname(file), target));
        } else {
          walk(inner);
        }
      }
    }
  };
  walk(schema);
  return found;
}

/** One strict Ajv 2020-12 instance holding K-09 v1.13 and K-05 v1.23 with every file their $refs reach. */
function frozenChecks(): (definition: string, value: unknown) => boolean {
  const ajv = new Ajv2020(AJV_OPTIONS);
  const held = new Set<string>();
  const queue = ["tool-api/tool-api.v1.13.schema.json", "data-access/data-access.v1.23.schema.json"];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (held.has(file)) continue;
    held.add(file);
    const schema = JSON.parse(readFileSync(path.join(CONTRACTS_DIR, ...file.split("/")), "utf8")) as object;
    ajv.addSchema(schema);
    queue.push(...refsOf(file, schema));
  }
  return (definition, value) => {
    const validate = ajv.getSchema(definition);
    if (validate === undefined) throw new Error(`no ${definition}`);
    // The frozen schemas are synchronous: Ajv answers a boolean for each.
    return validate(value) === true;
  };
}

const accepts = frozenChecks();
const asTurnRefused = (value: unknown): boolean => accepts(`${K09_V1_13}#/$defs/turnRefusedError`, value);
const asGateErrors = (value: unknown): boolean => accepts(`${K09_V1_13}#/$defs/gateAndCommit.errors`, value);
const asParkReason = (value: unknown): boolean => accepts(`${K05_V1_23}#/$defs/parkReason`, value);

// ---- the tests ----------------------------------------------------------------------------------------------------------

describe("every fault of every fault list is classed as T-1529's ruling 1 lists it (README v1.13 default 217)", () => {
  it("the six lists are K-09 v1.13's turnRefused.from, in its order", () => {
    expect([...REFUSAL_FROMS]).toEqual([
      "walk",
      "commit",
      "companies",
      "kinds",
      "kindsRead",
      "companiesRead",
    ]);
    expect(Object.keys(FAULT_CLASSES)).toEqual([...REFUSAL_FROMS]);
  });

  for (const from of REFUSAL_FROMS) {
    const list = RULING[from];
    it(`${from}: each member of ${list.type} (${list.file}) is in the ruling's list, and the table holds exactly its class`, () => {
      const members = unionOf(list.file, list.type);
      const named = [...list.final, ...list.transient, ...list.byIds];
      // Each member is named by the ruling once; a member the ruling does not name fails here.
      expect(new Set(named).size).toBe(named.length);
      expect([...members].sort(), `${list.type} against the ruling's list`).toEqual([...named].sort());
      // The table holds exactly the union's members, each with the ruling's class.
      const table = FAULT_CLASSES[from];
      expect(Object.keys(table).sort()).toEqual([...members].sort());
      for (const fault of members) expect(table[fault], `${from}: ${fault}`).toBe(rulingRuleOf(list, fault));
    });
  }

  it("the counts are the ruling's: walk 16 final and 1 transient, commit 12 and 2, companies 19 final, kinds 8 final and reviewRefused by its ids, kindsRead 2 and 1, companiesRead 3 and 1", () => {
    const counts = REFUSAL_FROMS.map((from) => {
      const rules = Object.values(FAULT_CLASSES[from]);
      return [
        from,
        rules.filter((rule) => rule === "final").length,
        rules.filter((rule) => rule === "transient").length,
        rules.filter((rule) => rule === "transientWhenIdsCarryTransient").length,
      ];
    });
    expect(counts).toEqual([
      ["walk", 16, 1, 0],
      ["commit", 12, 2, 0],
      ["companies", 19, 0, 0],
      ["kinds", 8, 0, 1],
      ["kindsRead", 2, 1, 0],
      ["companiesRead", 3, 1, 0],
    ]);
  });

  it("a fault no table holds has no class (refusal.ts default 2)", () => {
    expect(faultClassOf("walk", "aFaultNoListHolds", [])).toBeNull();
    expect(faultClassOf("kinds", "toString", [])).toBeNull();
    expect(faultClassOf("commit", "__proto__", [])).toBeNull();
  });
});

describe("a final fault gives turnRefused {from, fault, ids}, labels only; a transient one gives none", () => {
  for (const { from, fault, rule } of EVERY_FAULT) {
    if (rule === "transient") {
      it(`${from}: ${fault} is transient: no answer, so the base throws it as today; the schema refuses it as turnRefused`, () => {
        expect(turnRefusalOf(errorOf(from, fault))).toBeNull();
        expect(asTurnRefused({ error: "turnRefused", from, fault, ids: keptIdsOf(from) })).toBe(false);
      });
      continue;
    }
    it(`${from}: ${fault} is final: turnRefused with its labels, which K-09 v1.13 and K-05 v1.23's parkReason accept`, () => {
      const answer = turnRefusalOf(errorOf(from, fault));
      const expected: TurnRefusal = { error: "turnRefused", from, fault, ids: keptIdsOf(from) };
      expect(answer).toEqual(expected);
      expect(Object.keys(answer ?? {})).toEqual(["error", "from", "fault", "ids"]);
      expect(asTurnRefused(answer)).toBe(true);
      expect(asGateErrors(answer)).toBe(true);
      const { error, ...reason } = expected;
      expect(error).toBe("turnRefused");
      expect(asParkReason(reason)).toBe(true);
      // Nothing of the error but its labels: no message, no words, no number, no read's K-05 answer.
      const said = JSON.stringify(answer);
      for (const secret of [FICTION_NUMBER, "Sam Lee", MADE_UP_ROW, SQLSTATE, "nothing was written"]) {
        expect(said, secret).not.toContain(secret);
      }
    });
  }

  it("kinds' reviewRefused is transient when its ids carry openReviewItem's transient, and final with any other code", () => {
    expect(turnRefusalOf(new KindsRefusedError("reviewRefused", ["S1-03", "transient"]))).toBeNull();
    expect(faultClassOf("kinds", "reviewRefused", ["S1-03", "transient"])).toBe("transient");
    expect(
      asTurnRefused({
        error: "turnRefused",
        from: "kinds",
        fault: "reviewRefused",
        ids: ["S1-03", "transient"],
      }),
    ).toBe(false);
    const notFound = turnRefusalOf(new KindsRefusedError("reviewRefused", ["S1-03", "notFound"]));
    expect(notFound).toEqual({
      error: "turnRefused",
      from: "kinds",
      fault: "reviewRefused",
      ids: ["S1-03", "notFound"],
    });
    expect(asTurnRefused(notFound)).toBe(true);
    expect(turnRefusalOf(new KindsRefusedError("reviewRefused"))).toEqual({
      error: "turnRefused",
      from: "kinds",
      fault: "reviewRefused",
      ids: [],
    });
  });

  it("T-1529's two cases answer their v1.13 fixtures' outcomes: S1-04's second company and a step the bundle lacks", () => {
    // companies/writer.ts throws it naming S1-04 alone with the party flag off; the walk names the step it cannot reach.
    expect(turnRefusalOf(new CompaniesRefusedError("secondCompany", ["S1-04"]))).toEqual({
      error: "turnRefused",
      from: "companies",
      fault: "secondCompany",
      ids: ["S1-04"],
    });
    expect(turnRefusalOf(new WalkRefusedError("stepNotInBundle", ["S1-04"]))).toEqual({
      error: "turnRefused",
      from: "walk",
      fault: "stepNotInBundle",
      ids: ["S1-04"],
    });
  });

  it("a read's answer names the read alone, whatever K-05 answered; a read's transient gives none, whichever read", () => {
    for (const read of ["readKindCatalog", "readPickedKinds"] as const) {
      expect(turnRefusalOf(new KindsReadError(read, "noCatalog", null))).toEqual({
        error: "turnRefused",
        from: "kindsRead",
        fault: "noCatalog",
        ids: [read],
      });
      expect(
        turnRefusalOf(new KindsReadError(read, "transient", { error: "transient", sqlstate: SQLSTATE })),
      ).toBeNull();
    }
    for (const read of ["readPickedKinds", "readBusinessKinds", "readTurnState"] as const) {
      const answer = turnRefusalOf(
        new CompaniesReadError(read, "notFound", { error: "notFound", table: "persons", rowId: MADE_UP_ROW }),
      );
      expect(answer).toEqual({ error: "turnRefused", from: "companiesRead", fault: "notFound", ids: [read] });
      expect(JSON.stringify(answer)).not.toContain(MADE_UP_ROW);
      expect(turnRefusalOf(new CompaniesReadError(read, "transient", null))).toBeNull();
    }
  });

  it("any throw of another list, a notBuilt, a contract fault or an unknown throw gives none: thrown as today (open gap 204)", () => {
    const others: unknown[] = [
      new PlugInRefusedError("noPicks"),
      new ListingRefusedError("placesUnavailable", ["S1-76"]),
      new NotBuiltError("gateAndCommit"),
      new WalkNotBuiltError("buttons", ["S1-04"]),
      new CommitNotBuiltError("clockFiring"),
      new KindsNotBuiltError("gateAndCommit", "which", ["S1-02"]),
      new ToolApiContractError("gateAndCommit", ["/result is invalid"]),
      new TypeError("Sam Lee at +15555550131 broke it"),
      { name: "WalkRefusedError", fault: "stepNotInBundle", ids: ["S1-04"] },
      "stepNotInBundle",
      null,
      undefined,
    ];
    for (const thrown of others) expect(turnRefusalOf(thrown)).toBeNull();
  });

  it("a fault that is no label is none of the ruling's: no answer (refusal.ts default 2)", () => {
    expect(turnRefusalOf(new WalkRefusedError("step Not In Bundle" as WalkFault, ["S1-04"]))).toBeNull();
    expect(turnRefusalOf(new CommitRefusedError("aFaultNoListHolds" as CommitFault))).toBeNull();
  });
});

describe("the ids turnRefused carries: in their order, each once, only labels", () => {
  it("keeps the first of a repeat and leaves out what is no label (a number, words, an address, an empty id)", () => {
    expect(refusalIdsOf(["S1-04", "S1-08", "S1-04", "S1-02"])).toEqual(["S1-04", "S1-08", "S1-02"]);
    expect(
      refusalIdsOf([
        "S1-03",
        FICTION_NUMBER,
        "+15555550131",
        "Sam Lee",
        "sam@example.invalid",
        "",
        7,
        null,
        "S1-03",
      ]),
    ).toEqual(["S1-03"]);
    expect(refusalIdsOf([])).toEqual([]);
  });

  it("an error naming only ids that are no labels answers no id at all, and the schema still takes it", () => {
    const answer = turnRefusalOf(new CompaniesRefusedError("noPerson", [FICTION_NUMBER, "Sam Lee"]));
    expect(answer).toEqual({ error: "turnRefused", from: "companies", fault: "noPerson", ids: [] });
    expect(asTurnRefused(answer)).toBe(true);
  });

  it("the schema refuses what the answer never carries: a repeat, a number, words beside the labels", () => {
    const base = { error: "turnRefused", from: "companies", fault: "secondCompany" };
    expect(asTurnRefused({ ...base, ids: ["S1-04"] })).toBe(true);
    expect(asTurnRefused({ ...base, ids: ["S1-04", "S1-04"] })).toBe(false);
    expect(asTurnRefused({ ...base, ids: [FICTION_NUMBER] })).toBe(false);
    expect(asTurnRefused({ ...base, ids: ["S1-04"], text: "Plumbing and electrical share one" })).toBe(false);
  });
});
