// The audiences the claim check reads: K-04 v1's and the domain parts' table lists (02-contracts section 2 item 3) and
// K-03 v1's slot vocabulary, read in full, with the fields each slot reads named in them.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import slotsJson from "../../../../contracts/message-plan/fixtures/slots.json";
import { SLOT_NAMES } from "../slots";
import {
  FIELD_AUDIENCES,
  SLOT_AUDIENCES,
  SLOT_FIELDS,
  TABLE_LISTS,
  fieldAudience,
  fieldsOf,
  narrowest,
  slotAudience,
  tableAudience,
} from "./index";

const DB_SCHEMA = join(process.cwd(), "contracts", "db-schema");

function partAndVersion(list: unknown): { part: string; version: string } {
  const { part, version } = list as { part: unknown; version: unknown };
  if (typeof part !== "string" || typeof version !== "string")
    throw new TypeError("a table list names its part");
  return { part, version };
}

describe("the frozen table lists (K-04 v1 and the domain parts)", () => {
  it("reads only frozen versions, each once", () => {
    const seen = TABLE_LISTS.map((list) => {
      const { part, version } = partAndVersion(list);
      const frozen = JSON.parse(readFileSync(join(DB_SCHEMA, part, "frozen.json"), "utf8")) as {
        frozen: string[];
      };
      expect(frozen.frozen, `${part} ${version}`).toContain(version);
      return `${part} ${version}`;
    });
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain("core v1");
  });

  it("reads every column's audience: readers, secure page only or never", () => {
    let columns = 0;
    for (const list of TABLE_LISTS) {
      for (const { field, audience } of fieldsOf(list)) {
        columns += 1;
        expect(audience, field).not.toBeNull();
        expect(FIELD_AUDIENCES.get(field), field).toEqual(audience);
      }
    }
    expect(columns).toBe(FIELD_AUDIENCES.size);
    expect(fieldAudience("core.persons.name")).toEqual(["customer", "staff", "owner"]);
    expect(fieldAudience("bookings-changes.booking_visits.check_in_code")).toEqual(["customer"]);
    expect(fieldAudience("bookings-changes.booking_addresses.address")).toBe("secure-page-only");
    expect(fieldAudience("core.messages.words")).toBe("never");
    expect(fieldAudience("core.persons.nickname")).toBeNull();
  });
});

describe("the fields each slot reads", () => {
  it("names every slot of K-03 v1, and only those", () => {
    expect(Object.keys(SLOT_FIELDS).sort()).toEqual([...SLOT_NAMES].sort());
  });

  it("names only columns of the frozen table lists, each with an audience it can read", () => {
    for (const [slot, fields] of Object.entries(SLOT_FIELDS)) {
      for (const field of fields) expect(fieldAudience(field), `${slot}: ${field}`).not.toBeNull();
    }
  });
});

describe("the slots' own audiences (K-03 v1 slots.json)", () => {
  it("reads every slot's audience, securePageOnly or never only alone (K-03: a code check of C-091)", () => {
    expect(slotsJson.slots.map((slot) => slot.name)).toEqual([...SLOT_NAMES]);
    for (const slot of slotsJson.slots) {
      const audience: readonly string[] = slot.audience;
      if (audience.includes("securePageOnly") || audience.includes("never")) expect(audience).toHaveLength(1);
      expect(SLOT_AUDIENCES.get(slot.name), slot.name).not.toBeNull();
      expect(SLOT_AUDIENCES.get(slot.name), slot.name).toEqual(slotAudience(slot.audience));
    }
  });
});

describe("reading an audience", () => {
  it("reads a table list's form and refuses anything else", () => {
    expect(tableAudience(["owner"])).toEqual(["owner"]);
    expect(tableAudience("secure-page-only")).toBe("secure-page-only");
    expect(tableAudience("never")).toBe("never");
    for (const raw of [[], ["owner", "owner"], ["admin"], "securePageOnly", ["never"], null, undefined, 3]) {
      expect(tableAudience(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it("reads K-03's form, securePageOnly or never only alone", () => {
    expect(slotAudience(["customer", "owner"])).toEqual(["customer", "owner"]);
    expect(slotAudience(["securePageOnly"])).toBe("secure-page-only");
    expect(slotAudience(["never"])).toBe("never");
    for (const raw of [
      ["customer", "never"],
      ["securePageOnly", "owner"],
      [],
      "never",
      ["secure-page-only"],
    ]) {
      expect(slotAudience(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it("takes the narrowest: an unreadable audience over never, never over the rest, the readers every list names", () => {
    expect(narrowest([["customer", "owner"], null, "never"])).toEqual({ kind: "unknown" });
    expect(narrowest([])).toEqual({ kind: "unknown" });
    expect(narrowest([["customer"], "never", "secure-page-only"])).toEqual({ kind: "never" });
    expect(narrowest([["customer", "staff", "owner"], ["staff", "owner"], "secure-page-only"])).toEqual({
      kind: "readers",
      readers: new Set(["staff", "owner"]),
      securePageOnly: true,
    });
    expect(narrowest([["customer"], ["owner"]])).toEqual({
      kind: "readers",
      readers: new Set(),
      securePageOnly: false,
    });
  });
});
