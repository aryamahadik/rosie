// T-1302: the test-phone roster's one list (db/seeds/lib/roster.ts; K-05 v1.12 default 106), without a database. What the
// list must hold is read here from the frozen fixtures themselves (node:fs), never through the list: K-21 v1
// test-roster.json for the roster ids, their order and each phone's last four digits, and K-04 v1 seed-person-roles.json
// for test owner 1's handle. No value is a real person's: the numbers are the fictional 555-01xx (rule 9).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SKELETON_ROWS, TEST_OWNER_1 } from "../skeleton";
import { LEFT_OUT, stagingCoreRowsOf, TEST_PHONES, testPhoneNumbers } from "../staging-core";
import { FICTIONAL_MOBILE } from "./demo-shops";
import { ROSTER, rosterPhone, TEST_OWNER_1_PHONE } from "./roster";

const CONTRACTS = new URL("../../../contracts/", import.meta.url);
const LIST_FILE = new URL("./roster.ts", import.meta.url);

interface K21Phone {
  testPhoneId: string;
  last4: string;
}

interface K04Row {
  table: string;
  values: Record<string, unknown>;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, CONTRACTS), "utf8"));
const K21_PHONES = (readJson("page-api/fixtures/test-roster.json") as { outcome: { phones: K21Phone[] } })
  .outcome.phones;
const K04_HANDLES = (readJson("db-schema/core/fixtures/seed-person-roles.json") as { rows: K04Row[] }).rows
  .filter((row) => row.table === "handles")
  .map((row) => row.values);

describe("the roster's list follows K-21 v1's frozen test-roster.json", () => {
  it("holds K-21's five roster ids, in K-21's order", () => {
    expect(K21_PHONES).toHaveLength(5);
    expect(ROSTER.map((phone) => phone.testPhoneId)).toEqual(K21_PHONES.map((phone) => phone.testPhoneId));
  });

  it("gives each phone +1 555 555 and its last four digits on K-21's roster, in the fiction range", () => {
    expect(ROSTER.map((phone) => [phone.testPhoneId, phone.fakeNumber])).toEqual(
      K21_PHONES.map((phone) => [phone.testPhoneId, `+1555555${phone.last4}`]),
    );
    for (const phone of ROSTER) {
      expect(phone.fakeNumber, phone.testPhoneId).toMatch(FICTIONAL_MOBILE);
    }
  });

  it("gives each phone default 106's handle id: tp-01 test owner 1's handle-sam, K-04's handle at its number; the others handle-<roster id>", () => {
    const atTestOwnerNumber = K04_HANDLES.filter(
      (handle) => handle.address === TEST_OWNER_1_PHONE.fakeNumber,
    );
    expect(atTestOwnerNumber).toEqual([{ id: "handle-sam", kind: "phone", address: "+15555550100" }]);
    expect(ROSTER.map((phone) => [phone.testPhoneId, phone.handleId])).toEqual([
      ["tp-01", "handle-sam"],
      ["tp-02", "handle-tp-02"],
      ["tp-03", "handle-tp-03"],
      ["tp-04", "handle-tp-04"],
      ["tp-05", "handle-tp-05"],
    ]);
  });

  it("names each roster id, handle id and number once", () => {
    for (const field of ["testPhoneId", "handleId", "fakeNumber"] as const) {
      expect(new Set(ROSTER.map((phone) => phone[field])).size, field).toBe(ROSTER.length);
    }
  });

  it("test owner 1's entry is the roster's tp-01, and the roster cannot be changed at run time", () => {
    expect(ROSTER[0]).toBe(TEST_OWNER_1_PHONE);
    expect(TEST_OWNER_1_PHONE.testPhoneId).toBe("tp-01");
    expect(Object.isFrozen(ROSTER)).toBe(true);
    for (const phone of ROSTER) {
      expect(Object.isFrozen(phone), phone.testPhoneId).toBe(true);
    }
  });
});

describe("rosterPhone: a roster id's entry, as the test-phone page's binding finds its handle id", () => {
  it("finds every roster id's entry", () => {
    for (const phone of ROSTER) {
      expect(rosterPhone(phone.testPhoneId)).toBe(phone);
    }
  });

  it("answers null for an id not on the roster, compared exactly: never trimmed, folded or guessed", () => {
    for (const id of [
      "",
      "tp-06",
      "tp-00",
      "TP-01",
      " tp-01",
      "tp-01 ",
      "tp-1",
      "handle-sam",
      "+15555550100",
    ]) {
      expect(rosterPhone(id), JSON.stringify(id)).toBeNull();
    }
  });
});

describe("constants only: the Worker can import the list, and it holds no real number and no email", () => {
  const source = readFileSync(LIST_FILE, "utf8");

  it("imports nothing and reads no file, network or environment", () => {
    for (const reach of [
      /^\s*import\b/m,
      /\bimport\s*\(/,
      /\brequire\s*\(/,
      /\bprocess\b/,
      /\bfetch\s*\(/,
      /\bglobalThis\b/,
      /node:/,
    ]) {
      expect(source, String(reach)).not.toMatch(reach);
    }
  });

  it("holds no email address, and no phone-like string but the five fake numbers, each in the fiction range", () => {
    expect(source).not.toContain("@");
    const numbers = [...source.matchAll(/\+?[0-9][0-9 ().-]{8,}[0-9]/g)].map((match) => match[0]);
    expect([...numbers].sort()).toEqual(ROSTER.map((phone) => phone.fakeNumber).sort());
  });
});

describe("the seeds take their roster ids, handle ids and numbers from the list", () => {
  it("staging-core's TEST_PHONES are the list's roster ids and fake numbers, in its order; tp-01 is left out", () => {
    expect(TEST_PHONES).toEqual(
      ROSTER.map((phone) => ({ testPhoneId: phone.testPhoneId, fakeNumber: phone.fakeNumber })),
    );
    expect(LEFT_OUT).toEqual([TEST_OWNER_1_PHONE.testPhoneId]);
  });

  it("staging-core writes each test phone's handle under the list's handle id, at its fake number", () => {
    const barber = {
      id: "barber",
      name: "Barber",
      source: "test-kit/shops/barber.json",
      sha256: "0".repeat(64),
    };
    const { rows, testPhones } = stagingCoreRowsOf([barber], testPhoneNumbers(undefined));
    const seeded = ROSTER.filter((phone) => phone !== TEST_OWNER_1_PHONE);
    expect(rows.handles).toEqual(
      seeded.map((phone) => ({ id: phone.handleId, kind: "phone", address: phone.fakeNumber })),
    );
    expect(testPhones.map((phone) => [phone.testPhoneId, phone.handleId])).toEqual(
      seeded.map((phone) => [phone.testPhoneId, phone.handleId]),
    );
  });

  it("the skeleton seed's test owner 1 is the list's tp-01: its roster id, handle id and number", () => {
    expect(TEST_OWNER_1).toMatchObject({
      testPhoneId: TEST_OWNER_1_PHONE.testPhoneId,
      handleId: TEST_OWNER_1_PHONE.handleId,
    });
    expect(SKELETON_ROWS.handles).toEqual([
      { id: TEST_OWNER_1_PHONE.handleId, kind: "phone", address: TEST_OWNER_1_PHONE.fakeNumber },
    ]);
  });
});
