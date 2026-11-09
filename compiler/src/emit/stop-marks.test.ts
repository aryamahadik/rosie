// T-1116: how stop-marks.ts writes the markers the walks give (the walks themselves, and barber's bundle, are proved in
// emit.test.ts): a message gets exactly the marker it is given, a marker it is not given goes, and a list the walks did
// not trace as it is stops the build.
import { describe, expect, it } from "vitest";
import { masterHolder, messageKey, placeMarks, withStop, type StopMarks } from "./stop-marks";

const STOPS: StopMarks = {
  flow: "A",
  marks: new Map<string, true | "first">([
    [messageKey(masterHolder("S9-01"), "say", null, 1), true],
    [messageKey(masterHolder("S9-01"), "vary.addSay", "pf:x", 0), "first"],
  ]),
  lengths: new Map([
    [`${masterHolder("S9-01")} say`, 3],
    [`${masterHolder("S9-01")} vary.addSay pf:x`, 1],
  ]),
  paths: { barber: 3 },
};

describe("withStop: a message with the marker it is given", () => {
  it("sets true or 'first', keeping the other elements, and copies only what changes", () => {
    const plain = ["san", "staff", "Welcome"];
    expect(withStop(plain, true)).toStrictEqual(["san", "staff", "Welcome", { stop: true }]);
    expect(plain).toStrictEqual(["san", "staff", "Welcome"]);
    const named = ["san", "staff", "Welcome", { as: "Kim" }];
    expect(withStop(named, "first")).toStrictEqual(["san", "staff", "Welcome", { as: "Kim", stop: "first" }]);
    const marked = ["san", "staff", "Welcome", { stop: true }];
    expect(withStop(marked, true)).toBe(marked);
    expect(withStop(plain, null)).toBe(plain);
  });

  it("takes a marker away, and the elements with it when nothing else is left", () => {
    expect(withStop(["san", "owner", "Hi", { stop: "first" }], null)).toStrictEqual(["san", "owner", "Hi"]);
    expect(withStop(["san", "owner", "Hi", { stop: "first", as: "Pat" }], null)).toStrictEqual([
      "san",
      "owner",
      "Hi",
      { as: "Pat" },
    ]);
    expect(withStop(["san", "owner", "Hi", { stop: true }], "first")).toStrictEqual([
      "san",
      "owner",
      "Hi",
      { stop: "first" },
    ]);
  });

  it("writes a trade's message with no words, [from, to, elements], in its elements, third", () => {
    expect(withStop(["san", "cust", { photos: ["Board"] }], true)).toStrictEqual([
      "san",
      "cust",
      { photos: ["Board"], stop: true },
    ]);
    expect(withStop(["san", "cust", { stop: true }], null)).toStrictEqual(["san", "cust", {}]);
  });
});

describe("placeMarks: a list marked as the walks give it", () => {
  it("gives each message its marker by holder, list, variant and index, and none to any other", () => {
    const say = [
      ["staff", "san", "YES", { as: "Kim" }],
      ["san", "staff", "Welcome", { as: "Kim" }],
      ["san", "staff", "Later", { as: "Kim", stop: "first" }],
    ];
    expect(placeMarks(STOPS, say, masterHolder("S9-01"), "say", null)).toStrictEqual([
      ["staff", "san", "YES", { as: "Kim" }],
      ["san", "staff", "Welcome", { as: "Kim", stop: true }],
      ["san", "staff", "Later", { as: "Kim" }],
    ]);
    expect(
      placeMarks(STOPS, [["san", "cust", "Hi"]], masterHolder("S9-01"), "vary.addSay", "pf:x"),
    ).toStrictEqual([["san", "cust", "Hi", { stop: "first" }]]);
  });

  it("refuses a list the walks did not trace, or traced with another length", () => {
    expect(() => placeMarks(STOPS, [["san", "cust", "Hi"]], masterHolder("S9-02"), "say", null)).toThrow(
      /the walks traced none/,
    );
    expect(() => placeMarks(STOPS, [["san", "cust", "Hi"]], masterHolder("S9-01"), "say", null)).toThrow(
      /1 messages, but the walks traced 3/,
    );
  });
});
