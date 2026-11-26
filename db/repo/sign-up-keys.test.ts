// T-1561: what db/repo's readSignUpKeys (K-05 v1.24 item 85) checks before any statement. No database: every read here is
// sent through a client that throws the moment it is touched, so a request the call refuses is shown refused before any
// statement (a TypeError naming its field, never its value), and a request it accepts is shown to reach the client (the
// client's own error, never a TypeError). What the read answers is db/repo/sign-up-keys.int.test.ts's.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Sql } from "./scope";
import { readSignUpKeys, type ReadSignUpKeysRequest } from "./sign-up-keys";

const FIXTURES = new URL("../../contracts/data-access/fixtures/", import.meta.url);
const SENT = "a statement was sent";

/** A client no statement may reach: sending one, or reading anything of it, throws an Error that is no TypeError. */
const untouched = new Proxy(() => undefined, {
  apply() {
    throw new Error(SENT);
  },
  get() {
    throw new Error(SENT);
  },
}) as unknown as Sql;

const requestOf = (file: string): unknown =>
  (JSON.parse(readFileSync(new URL(file, FIXTURES), "utf8")) as { request: unknown }).request;

async function thrownBy(request: unknown): Promise<unknown> {
  try {
    await readSignUpKeys(untouched, request as ReadSignUpKeysRequest);
  } catch (error) {
    return error;
  }
  return null;
}

describe("readSignUpKeys before any statement (K-05 v1.24 item 85)", () => {
  it("sends each fixture's request on to the client", async () => {
    for (const file of ["read-sign-up-keys-sam.json", "read-sign-up-keys-before-upload.json"]) {
      const error = await thrownBy(requestOf(file));
      expect(error, file).not.toBeInstanceOf(TypeError);
      expect((error as Error).message, file).toBe(SENT);
    }
  });

  it("refuses a request of the wrong shape with a TypeError naming the field, never its value", async () => {
    const number = "+15555550100";
    const refused: [unknown, string][] = [
      [undefined, "readSignUpKeys: the request is an object"],
      [null, "readSignUpKeys: the request is an object"],
      ["person-sam", "readSignUpKeys: the request is an object"],
      [["person-sam"], "readSignUpKeys: the request is an object"],
      [{}, "readSignUpKeys: personId is a K-04 person id, a non-empty text"],
      [{ personId: "" }, "readSignUpKeys: personId is a K-04 person id, a non-empty text"],
      [{ personId: null }, "readSignUpKeys: personId is a K-04 person id, a non-empty text"],
      [{ personId: 1 }, "readSignUpKeys: personId is a K-04 person id, a non-empty text"],
      [{ personId: "person\u0000sam" }, "readSignUpKeys: personId is a K-04 person id, a non-empty text"],
      [{ personId: "person-sam", number }, "readSignUpKeys: the request takes only personId"],
      [{ personId: "person-sam", objectKey: "\\x00" }, "readSignUpKeys: the request takes only personId"],
    ];
    for (const [request, message] of refused) {
      const error = await thrownBy(request);
      expect(error, message).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(message);
      expect((error as Error).message.includes(number)).toBe(false);
    }
  });
});
