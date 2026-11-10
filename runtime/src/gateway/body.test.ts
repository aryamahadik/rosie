// The capped body read (T-1180; body.ts), under Node as the unit project runs Workers code; body.worker.test.ts runs the
// same reads inside the Workers runtime. A body at its cap is read; one byte over is refused, by its declared length
// before a byte is read, or else at the chunk that goes over, with the rest of the stream cancelled and never read.
import { describe, expect, it } from "vitest";

import { LINQ_BODY_LIMIT_BYTES, PAGE_BODY_LIMIT_BYTES, bodyLimitOf, readCappedText } from "./body";
import { bodyTexts, countedStream, postOf, twoByteOrderMarks, xBytes } from "./test-support";

describe("readCappedText", () => {
  it("reads a body at its cap whole, and refuses one a byte over it", async () => {
    expect(await readCappedText(postOf("a".repeat(100)), 100)).toEqual({ text: "a".repeat(100) });
    expect(await readCappedText(postOf("a".repeat(101)), 100)).toEqual({ problem: "tooLarge" });
  });

  it("counts bytes, not characters: 50 two-byte characters are 100 bytes", async () => {
    expect(await readCappedText(postOf("é".repeat(50)), 100)).toEqual({ text: "é".repeat(50) });
    expect(await readCappedText(postOf("é".repeat(51)), 101)).toEqual({ problem: "tooLarge" });
  });

  it("refuses a declared length over the cap before a byte is read", async () => {
    const source = countedStream(4, () => xBytes(10));

    const read = await readCappedText(postOf(source.stream, { "content-length": "101" }), 100);

    expect(read).toEqual({ problem: "tooLarge" });
    expect(source.pulled()).toBe(0);
  });

  it("counts what it reads whatever length is declared: a body that sends more than it declares is still refused", async () => {
    const source = countedStream(20, () => xBytes(10));

    const read = await readCappedText(postOf(source.stream, { "content-length": "40" }), 100);

    expect(read).toEqual({ problem: "tooLarge" });
    expect(source.pulled()).toBe(11);
    expect(source.cancelled()).toBe(true);
  });

  it("refuses a body with no declared length at the chunk that goes over, cancels the rest and never reads it (a 1 GiB body, 5 KiB read)", async () => {
    const source = countedStream(1024 * 1024, () => xBytes(1024));

    const read = await readCappedText(postOf(source.stream), 4 * 1024);

    expect(read).toEqual({ problem: "tooLarge" });
    expect(source.pulled()).toBe(5);
    expect(source.cancelled()).toBe(true);
  });

  it("reads a streamed body under its cap whole, chunk by chunk", async () => {
    const source = countedStream(4, () => xBytes(25));

    const read = await readCappedText(postOf(source.stream), 100);

    expect(read).toEqual({ text: "x".repeat(100) });
    expect(source.pulled()).toBe(4);
    expect(source.cancelled()).toBe(false);
  });

  it("takes a declared length that is not digits as none, and counts the bytes", async () => {
    for (const declared of ["", "abc", "-1", "1e9", "12, 12", "0x10"]) {
      const body = "a".repeat(100);
      expect(await readCappedText(postOf(body, { "content-length": declared }), 100), declared).toEqual({
        text: body,
      });
    }
  });

  it("reads the text request.text() reads: UTF-8, a byte-order mark dropped, a malformed byte as U+FFFD", async () => {
    for (const bytes of bodyTexts()) {
      const expected = await postOf(bytes).text();
      expect(await readCappedText(postOf(bytes), 1024), JSON.stringify(expected)).toEqual({ text: expected });
    }
  });

  it("drops one byte-order mark only, as the Encoding standard and the Workers runtime's request.text() do", async () => {
    expect(await readCappedText(postOf(twoByteOrderMarks()), 100)).toEqual({
      text: String.fromCodePoint(0xfeff) + "a",
    });
  });

  it("joins a character split across two chunks", async () => {
    const halves = [new Uint8Array([0xc3]), new Uint8Array([0xa9])];
    const source = countedStream(2, (index) => halves[index] ?? new Uint8Array());

    expect(await readCappedText(postOf(source.stream), 10)).toEqual({ text: "é" });
  });

  it("reads no body as the empty text", async () => {
    expect(await readCappedText(new Request("https://rosie.test/x", { method: "POST" }), 0)).toEqual({
      text: "",
    });
    expect(await readCappedText(new Request("https://rosie.test/x"), 0)).toEqual({ text: "" });
  });

  it("answers unreadable with the stream's error, and nothing of the body, when the stream fails", async () => {
    const failure = new Error("the connection closed");
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(failure);
      },
    });

    expect(await readCappedText(postOf(stream), 100)).toEqual({ problem: "unreadable", error: failure });
  });

  it("answers unreadable, never throwing, for a body read before", async () => {
    const request = postOf("{}");
    await request.text();

    expect(await readCappedText(request, 100)).toMatchObject({ problem: "unreadable" });
  });
});

describe("bodyLimitOf: the cap a door reads under", () => {
  it("is the configured value when it is a whole number of bytes from 0", () => {
    for (const configured of [0, 1, 1024, PAGE_BODY_LIMIT_BYTES, 10 * 1024 * 1024]) {
      expect(bodyLimitOf(configured, PAGE_BODY_LIMIT_BYTES)).toBe(configured);
    }
  });

  it("is the door's default when left out or not a whole number from 0, so a mistyped value never lifts the cap", () => {
    for (const configured of [undefined, Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, 2 ** 60]) {
      expect(bodyLimitOf(configured, LINQ_BODY_LIMIT_BYTES), String(configured)).toBe(LINQ_BODY_LIMIT_BYTES);
    }
  });

  it("defaults: 64 KiB for the page entry, 256 KiB for the Linq webhook", () => {
    expect(PAGE_BODY_LIMIT_BYTES).toBe(65_536);
    expect(LINQ_BODY_LIMIT_BYTES).toBe(262_144);
  });
});
