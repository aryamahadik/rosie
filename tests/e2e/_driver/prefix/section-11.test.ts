// 02-contracts section 11 as the hop-prefix mode reads it (T-551): its 13 hop rows cut T-465's SKELETON_HOPS into runs,
// each skeleton hop in one row, in turn order; each row's join name is the one its join task runs (T-552 to T-563); and
// each contract a row names has the v1 contract test its README names. Run by `npm run test:e2e -- _driver/prefix`.

import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "../../../contract/_harness";
import { SKELETON_HOPS } from "../index";
import { SECTION_11_ROWS, contractTestOf, rowOfHop, type ContractId } from "./index";

describe("02-contracts section 11's hop rows", () => {
  it("are its 13 hop rows, in turn order, which cut SKELETON_HOPS into runs: each skeleton hop in one row", () => {
    expect(SECTION_11_ROWS.map((row) => row.row)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(SECTION_11_ROWS.flatMap((row) => row.hops)).toEqual([...SKELETON_HOPS]);
    expect(SECTION_11_ROWS.every((row) => row.hops.length > 0)).toBe(true);
  });

  it("puts two K-08 hops in each row T-465's mapping splits: batch and lease, gate and commit, delivered and the clock", () => {
    expect(
      SECTION_11_ROWS.filter((row) => row.hops.length > 1).map((row) => [row.row, row.words, row.hops]),
    ).toEqual([
      [4, "Batch and turn lease", ["batch", "lease"]],
      [
        8,
        "Gate and one commit: state, the open question and its clock row, one outbox row, the event log, under the turn id",
        ["gate", "commit"],
      ],
      [13, "Delivery receipt; the clock arms", ["delivered", "clockArmed"]],
    ]);
  });

  it("starts with the webhook in at the gateway (receive) and ends with the clock armed", () => {
    expect(SECTION_11_ROWS[0]).toMatchObject({
      row: 1,
      words: "Webhook in, signature checked",
      hops: ["receive"],
    });
    expect(SECTION_11_ROWS.at(-1)?.hops.at(-1)).toBe("clockArmed");
  });

  it("names rows 1 to 12 as their join tasks run them (T-552 to T-563), and row 13 not at all (T-564 runs the full check)", () => {
    expect(SECTION_11_ROWS.map((row) => row.join)).toEqual([
      "gateway",
      "actor-inbox",
      "safety-read",
      "lease",
      "guard",
      "frontier",
      "decide",
      "commit",
      "compose",
      "finalize",
      "dispatch",
      "send",
      null,
    ]);
  });

  it("gives a join name that is also a K-08 hop name only to the row that ends at that hop", () => {
    for (const row of SECTION_11_ROWS) {
      const join = row.join;
      if (join !== null && (SKELETON_HOPS as readonly string[]).includes(join)) {
        expect([join, row.hops.at(-1)]).toEqual([join, join]);
      }
    }
  });

  it.each(SKELETON_HOPS)("finds the row of hop %s", (hop) => {
    const row = rowOfHop(hop);
    expect(row.hops).toContain(hop);
    expect(SECTION_11_ROWS.filter((candidate) => candidate.hops.includes(hop))).toEqual([row]);
  });
});

describe("each row's contracts and their tests", () => {
  it("are section 11's contracts, row by row (its column 'Contract (and its test)')", () => {
    expect(SECTION_11_ROWS.map((row) => row.contracts)).toEqual([
      ["K-11"],
      ["K-06"],
      ["K-02"],
      ["K-04", "K-06"],
      ["K-01", "K-04"],
      ["K-09", "K-02", "K-01"],
      ["K-02"],
      ["K-09", "K-05", "K-04", "K-07", "K-08"],
      ["K-09", "K-03"],
      ["K-09", "K-03"],
      ["K-05", "K-07"],
      ["K-11"],
      ["K-06", "K-05"],
    ]);
  });

  const contracts = [...new Set(SECTION_11_ROWS.flatMap((row) => row.contracts))].sort();

  it("name each of K-01 to K-09 and K-11, the contracts the walking skeleton reads (02-contracts section 10)", () => {
    expect(contracts).toEqual([
      "K-01",
      "K-02",
      "K-03",
      "K-04",
      "K-05",
      "K-06",
      "K-07",
      "K-08",
      "K-09",
      "K-11",
    ]);
  });

  it("each have the v1 contract test their README names, under tests/contract/ by the contract's folder", () => {
    expect(contracts.map((contract) => [contract, contractTestOf(contract).name])).toEqual([
      ["K-01", "bundle"],
      ["K-02", "model"],
      ["K-03", "message-plan"],
      ["K-04", "db-schema/core"],
      ["K-05", "data-access"],
      ["K-06", "inbound-event"],
      ["K-07", "outbox-effects"],
      ["K-08", "event-trace"],
      ["K-09", "tool-api"],
      ["K-11", "port-linq"],
    ]);
    for (const contract of contracts) {
      const test = contractTestOf(contract);
      expect(test.contract).toBe(contract);
      expect(test.file).toBe(`tests/contract/${test.name.replace("/", ".")}.v1.test.ts`);
    }
  });

  it("gives the gateway hop K-11's test, tests/contract/port-linq.v1.test.ts, which is in the repository", () => {
    const [contract] = SECTION_11_ROWS[0]?.contracts ?? [];
    expect(contract).toBe("K-11");
    const file = contractTestOf("K-11").file;
    expect(file).toBe("tests/contract/port-linq.v1.test.ts");
    expect(existsSync(path.join(REPO_ROOT, file))).toBe(true);
  });

  it.each(["K-99", "K-1", "K-00"] as ContractId[])(
    "refuses %s, which no contract README names with a v1 test",
    (id) => {
      expect(() => contractTestOf(id)).toThrow(
        `0 contract READMEs under contracts/ name ${id} with a v1 contract test, where one must`,
      );
    },
  );
});
