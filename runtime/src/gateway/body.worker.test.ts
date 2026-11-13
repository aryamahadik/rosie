// The capped body read (T-1180; body.ts) inside the Workers runtime, where the Worker runs it: the same text as
// request.text() gives there, and a body over its cap refused before it is read whole.
import { describe, expect, it } from "vitest";

import { readCappedText } from "./body";
import { bodyTexts, countedStream, postOf, twoByteOrderMarks, xBytes } from "./test-support";

describe("readCappedText in the Workers runtime", () => {
  it("reads the text request.text() reads here, for every kind of body, two byte-order marks included", async () => {
    for (const bytes of [...bodyTexts(), twoByteOrderMarks()]) {
      const expected = await postOf(bytes).text();
      expect(await readCappedText(postOf(bytes), 1024), JSON.stringify(expected)).toEqual({ text: expected });
    }
    expect(await postOf(twoByteOrderMarks()).text()).toBe(String.fromCodePoint(0xfeff) + "a");
  });

  it("reads a body at its cap whole, and refuses one a byte over it", async () => {
    expect(await readCappedText(postOf("a".repeat(100)), 100)).toEqual({ text: "a".repeat(100) });
    expect(await readCappedText(postOf("a".repeat(101)), 100)).toEqual({ problem: "tooLarge" });
  });

  it("refuses a streamed body with no declared length at the chunk that goes over, and cancels the rest", async () => {
    const source = countedStream(1024 * 1024, () => xBytes(1024));

    const read = await readCappedText(postOf(source.stream), 4 * 1024);

    expect(read).toEqual({ problem: "tooLarge" });
    expect(source.pulled()).toBeLessThan(16);
    expect(source.cancelled()).toBe(true);
  });
});
