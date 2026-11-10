// T-1185: K-04's text form of a bytea value ("\x" and hex digit pairs) read as the bytes it spells, and every other
// form refused (`npm run test:unit -- db/repo/bytea`). commit-turn.int.test.ts and clocks.int.test.ts prove the writes
// on PostgreSQL.
import { describe, expect, it } from "vitest";
import { byteaFromText } from "./bytea";

/** Every byte value once, 0x00 to 0xff, and the text form a commit is given for them (actions' byteaText writes it). */
const EVERY_BYTE = Uint8Array.from({ length: 256 }, (_, index) => index);
const EVERY_BYTE_HEX = [...EVERY_BYTE].map((byte) => byte.toString(16).padStart(2, "0")).join("");

describe("byteaFromText: K-04's text form as its bytes", () => {
  it("reads each pair of hex digits after \\x as one byte, every byte value from 0x00 to 0xff", () => {
    expect(byteaFromText(`\\x${EVERY_BYTE_HEX}`)).toEqual(EVERY_BYTE);
    expect(byteaFromText("\\x01ab")).toEqual(Uint8Array.of(0x01, 0xab));
  });

  it("reads hex digits in upper or lower case alike", () => {
    expect(byteaFromText(`\\x${EVERY_BYTE_HEX.toUpperCase()}`)).toEqual(EVERY_BYTE);
    expect(byteaFromText("\\x0aBc")).toEqual(Uint8Array.of(0x0a, 0xbc));
  });

  it("reads \\x alone as no bytes", () => {
    expect(byteaFromText("\\x")).toEqual(new Uint8Array(0));
  });

  it("gives bytes, never the characters of the text (what postgres.js would store for a string)", () => {
    const bytes = byteaFromText("\\x01ab");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).not.toEqual(new TextEncoder().encode("\\x01ab"));
    expect(bytes?.length).toBe(2);
  });
});

describe("byteaFromText: anything else is refused (null), never read in part", () => {
  const refused: [string, unknown][] = [
    ["an empty string", ""],
    ["hex with no \\x", "01ab"],
    ["x with no backslash", "x01ab"],
    ["an upper-case \\X", "\\X01ab"],
    ["a doubled backslash", "\\\\x01ab"],
    ["an odd number of hex digits", "\\x01a"],
    ["one hex digit", "\\x1"],
    ["a character that is not hex at the end", "\\x01ag"],
    ["a character that is not hex at the start", "\\xg1ab"],
    ["a space between the pairs", "\\x01 ab"],
    ["a space before the text", " \\x01ab"],
    ["a line break after the text", "\\x01ab\n"],
    ["the escape format", "Words of a text\\000"],
    ["plain words", "lips are swelling"],
    ["a 0x prefix", "0x01ab"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 171],
    ["a boolean", true],
    ["a list of byte values", [1, 171]],
    ["an object", { hex: "01ab" }],
    ["bytes already made", Uint8Array.of(1, 171)],
  ];
  for (const [what, value] of refused) {
    it(`refuses ${what}`, () => {
      expect(byteaFromText(value)).toBeNull();
    });
  }
});
