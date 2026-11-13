// The code's draw and the session token (T-322; ADR-016 card A's added proofs; DL-526): the draw rejects the top range,
// so each of the million codes is equally likely, and the session token is 32 bytes from the same generator.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CODE_SPACE,
  CodeDrawError,
  DRAW_LIMIT,
  MAX_DRAWS,
  SESSION_TOKEN_BYTES,
  drawCode,
  newSessionToken,
} from "./draw";
import { scriptedFill } from "./test-support";

const TWO_TO_32 = 2 ** 32;

/** The bytes a base64url text holds (RFC 4648 section 5), decoded apart from the code under test. */
function bytesOf(base64url: string): number[] {
  const binary = atob(base64url.replace(/-/gu, "+").replace(/_/gu, "/"));
  return Array.from(binary, (char) => char.charCodeAt(0));
}

describe("the code's draw", () => {
  it("rejects every 32-bit draw at or above 4,294,000,000 and takes the next one", () => {
    const top = scriptedFill([DRAW_LIMIT, 482_913]);
    expect(drawCode(top.fill)).toBe("482913");
    expect(top.asked).toEqual([
      { kind: "uint32", length: 1 },
      { kind: "uint32", length: 1 },
    ]);

    const highest = scriptedFill([TWO_TO_32 - 1, DRAW_LIMIT + 1, 7]);
    expect(drawCode(highest.fill)).toBe("000007");
    expect(highest.asked).toHaveLength(3);
  });

  it("takes a draw just below the top range, modulo 1,000,000 and zero-padded to six digits", () => {
    const below = scriptedFill([DRAW_LIMIT - 1]);
    expect(drawCode(below.fill)).toBe("999999");
    expect(below.asked).toHaveLength(1);
    expect(drawCode(scriptedFill([0]).fill)).toBe("000000");
    expect(drawCode(scriptedFill([1_000_042]).fill)).toBe("000042");
  });

  it("keeps the largest multiple of 1,000,000 below 2^32, so each code has the same 4,294 draws", () => {
    expect(DRAW_LIMIT).toBe(4_294_000_000);
    expect(DRAW_LIMIT % CODE_SPACE).toBe(0);
    expect(DRAW_LIMIT).toBeLessThanOrEqual(TWO_TO_32);
    expect(DRAW_LIMIT + CODE_SPACE).toBeGreaterThan(TWO_TO_32);
    // The draws a code is taken from are code, code + 10^6, ..., below the limit: as many for the first code as the last.
    const drawsOf = (code: number): number => Math.ceil((DRAW_LIMIT - code) / CODE_SPACE);
    expect(drawsOf(0)).toBe(4_294);
    expect(drawsOf(967_295)).toBe(4_294);
    expect(drawsOf(999_999)).toBe(4_294);
  });

  it("stops after MAX_DRAWS draws in the top range, naming no draw", () => {
    const stuck = scriptedFill(Array.from({ length: MAX_DRAWS }, () => TWO_TO_32 - 1));
    let thrown: unknown;
    try {
      drawCode(stuck.fill);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CodeDrawError);
    expect(stuck.asked).toHaveLength(MAX_DRAWS);
    expect((thrown as Error).message).not.toMatch(/\d{7,}/u);
  });

  it("draws six digits from Web Crypto by default", () => {
    for (let index = 0; index < 200; index += 1) expect(drawCode()).toMatch(/^[0-9]{6}$/u);
  });
});

describe("the session token", () => {
  it("is 32 bytes from the generator, in base64url, kept by the server only as its sha256", async () => {
    const bytes = Array.from({ length: SESSION_TOKEN_BYTES }, (_, index) => 200 + index);
    const fill = scriptedFill(bytes);
    const session = await newSessionToken(fill.fill);
    expect(SESSION_TOKEN_BYTES).toBe(32);
    expect(fill.asked).toEqual([{ kind: "uint8", length: 32 }]);
    const decoded = bytesOf(session.token);
    expect(decoded).toHaveLength(32);
    expect(decoded).toEqual(bytes.map((value) => value & 0xff));
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(session.tokenSha256).toBe(createHash("sha256").update(session.token, "utf8").digest("hex"));
    expect(session.tokenSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("is 32 fresh bytes from Web Crypto by default", async () => {
    const one = await newSessionToken();
    const two = await newSessionToken();
    expect(bytesOf(one.token)).toHaveLength(32);
    expect(bytesOf(two.token)).toHaveLength(32);
    expect(one.token).not.toBe(two.token);
    // K-21 v1 opaqueToken: 16 to 512 characters.
    expect(one.token.length).toBeGreaterThanOrEqual(16);
    expect(one.token.length).toBeLessThanOrEqual(512);
  });
});
