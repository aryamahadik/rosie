// T-200: the demo shops and the core rows made from them (db/seeds/lib/demo-shops.ts), without files or a database.
import { describe, expect, it } from "vitest";
import { coreRowsOf, type DemoShop, FICTIONAL_MOBILE, fictionalMobile, readDemoShops } from "./demo-shops";
import type { VerifiedFile } from "./fixture-set";

/** A verified file as fixture-set.ts hands it over, with made-up bytes (no fixture is read here). */
const file = (path: string, content: unknown): VerifiedFile => ({
  path,
  sha256: "0".repeat(64),
  bytes: new TextEncoder().encode(typeof content === "string" ? content : JSON.stringify(content)),
});

const shop = (id: string, name: string): DemoShop => ({
  id,
  name,
  source: `test-kit/shops/${id}.json`,
  sha256: "1".repeat(64),
});

describe("fictionalMobile", () => {
  it("gives the shops, in order, 555-0100 to 555-0199 in area code 212, then 312, then 415", () => {
    expect([0, 1, 99, 100, 199, 200, 244, 299].map((index) => fictionalMobile(index))).toEqual([
      "+12125550100",
      "+12125550101",
      "+12125550199",
      "+13125550100",
      "+13125550199",
      "+14155550100",
      "+14155550144",
      "+14155550199",
    ]);
  });

  it("gives 300 different numbers, every one in the fiction range", () => {
    const numbers = Array.from({ length: 300 }, (_, index) => fictionalMobile(index));
    expect(new Set(numbers).size).toBe(300);
    for (const number of numbers) {
      expect(number).toMatch(FICTIONAL_MOBILE);
      expect(number).toMatch(/^\+1[2-9][0-9]{2}55501[0-9]{2}$/);
    }
  });

  it("refuses an index past the 300 numbers, a negative one or a fraction", () => {
    for (const index of [300, -1, 1.5, Number.NaN]) {
      expect(() => fictionalMobile(index), String(index)).toThrow(RangeError);
    }
  });
});

describe("readDemoShops", () => {
  it("reads each shop's id and name with its file and hash, in code-point order of id", () => {
    const shops = readDemoShops([
      file("test-kit/shops/yoga.json", { id: "yoga", name: "Yoga studio", flows: {} }),
      file("test-kit/shops/test-mixed-A.json", { id: "test-mixed-A", name: "Test Mixed Shop A" }),
      file("test-kit/shops/barber.json", { id: "barber", name: "Barber" }),
    ]);
    expect(shops).toEqual([
      { id: "barber", name: "Barber", source: "test-kit/shops/barber.json", sha256: "0".repeat(64) },
      {
        id: "test-mixed-A",
        name: "Test Mixed Shop A",
        source: "test-kit/shops/test-mixed-A.json",
        sha256: "0".repeat(64),
      },
      { id: "yoga", name: "Yoga studio", source: "test-kit/shops/yoga.json", sha256: "0".repeat(64) },
    ]);
  });

  it.each([
    [
      "an id that is not the file name",
      file("test-kit/shops/barber.json", { id: "barbers", name: "Barber" }),
      "is not its file name",
    ],
    ["no id", file("test-kit/shops/barber.json", { name: "Barber" }), "is not its file name"],
    [
      "an id with other characters",
      file("test-kit/shops/bar_ber.json", { id: "bar_ber", name: "Barber" }),
      "letters, digits and dashes",
    ],
    ["no name", file("test-kit/shops/barber.json", { id: "barber" }), "has no name"],
    ["a blank name", file("test-kit/shops/barber.json", { id: "barber", name: "  " }), "has no name"],
    [
      "a name with a phone number",
      file("test-kit/shops/barber.json", { id: "barber", name: "Barber (212) 555-0123" }),
      "looks like a phone number",
    ],
    [
      "a name with an email address",
      file("test-kit/shops/barber.json", { id: "barber", name: "sam@example.com" }),
      "looks like a phone number",
    ],
    ["bytes that are not JSON", file("test-kit/shops/barber.json", "{ not json"), "not JSON"],
    ["a JSON array", file("test-kit/shops/barber.json", "[]"), "not a JSON object"],
    [
      "a file in a folder below shops/",
      file("test-kit/shops/more/barber.json", { id: "barber", name: "Barber" }),
      "not a demo shop file",
    ],
    [
      "a file that is not JSON by name",
      file("test-kit/shops/barber.md", { id: "barber", name: "Barber" }),
      "not a demo shop file",
    ],
    [
      "a file outside shops/",
      file("forms/barber.json", { id: "barber", name: "Barber" }),
      "not a demo shop file",
    ],
  ])("refuses %s, naming the file", (_what, bad, message) => {
    expect(() => readDemoShops([bad])).toThrow(message);
    expect(() => readDemoShops([bad])).toThrow(bad.path);
  });

  it("refuses bytes that are not UTF-8 rather than reading them with replacement characters", () => {
    const bad: VerifiedFile = {
      path: "test-kit/shops/barber.json",
      sha256: "0".repeat(64),
      bytes: Uint8Array.from([0x22, 0xff, 0x22]),
    };
    expect(() => readDemoShops([bad])).toThrow("test-kit/shops/barber.json: not JSON in UTF-8");
  });

  it("keeps a name with a few digits, which is not a phone number", () => {
    expect(
      readDemoShops([file("test-kit/shops/studio.json", { id: "studio", name: "Studio 54" })])[0]?.name,
    ).toBe("Studio 54");
  });
});

describe("coreRowsOf", () => {
  it("makes each shop's business head, owner, owner role, handle, handle link and phone row, with keys from its id", () => {
    const { rows, seeded } = coreRowsOf([shop("yoga", "Yoga studio"), shop("barber", "Barber")]);
    expect(rows).toEqual({
      businesses: [
        { id: "biz-demo-barber", name: "Barber", display_name: "Barber", time_zone: "America/New_York" },
        {
          id: "biz-demo-yoga",
          name: "Yoga studio",
          display_name: "Yoga studio",
          time_zone: "America/New_York",
        },
      ],
      persons: [{ id: "person-demo-barber-owner" }, { id: "person-demo-yoga-owner" }],
      person_roles: [
        {
          id: "role-demo-barber-owner",
          person_id: "person-demo-barber-owner",
          business_id: "biz-demo-barber",
          role: "owner",
        },
        {
          id: "role-demo-yoga-owner",
          person_id: "person-demo-yoga-owner",
          business_id: "biz-demo-yoga",
          role: "owner",
        },
      ],
      handles: [
        { id: "handle-demo-barber-owner", kind: "phone", address: "+12125550100" },
        { id: "handle-demo-yoga-owner", kind: "phone", address: "+12125550101" },
      ],
      person_handles: [
        { person_id: "person-demo-barber-owner", handle_id: "handle-demo-barber-owner" },
        { person_id: "person-demo-yoga-owner", handle_id: "handle-demo-yoga-owner" },
      ],
      phones: [
        { number: "+12125550100", handle_id: "handle-demo-barber-owner" },
        { number: "+12125550101", handle_id: "handle-demo-yoga-owner" },
      ],
    });
    expect(seeded).toEqual([
      {
        shopId: "barber",
        source: "test-kit/shops/barber.json",
        sha256: "1".repeat(64),
        businessId: "biz-demo-barber",
        personId: "person-demo-barber-owner",
        roleId: "role-demo-barber-owner",
        handleId: "handle-demo-barber-owner",
        phoneNumber: "+12125550100",
      },
      {
        shopId: "yoga",
        source: "test-kit/shops/yoga.json",
        sha256: "1".repeat(64),
        businessId: "biz-demo-yoga",
        personId: "person-demo-yoga-owner",
        roleId: "role-demo-yoga-owner",
        handleId: "handle-demo-yoga-owner",
        phoneNumber: "+12125550101",
      },
    ]);
  });

  it("makes the same rows whatever order the shops come in", () => {
    const shops = [shop("a", "A"), shop("b", "B"), shop("C", "C"), shop("test-mixed-A", "T")];
    expect(coreRowsOf([...shops].reverse())).toEqual(coreRowsOf(shops));
  });

  it("refuses two shops with one id", () => {
    expect(() => coreRowsOf([shop("barber", "Barber"), shop("barber", "Barber again")])).toThrow(
      "two demo shops have the id barber",
    );
  });
});
