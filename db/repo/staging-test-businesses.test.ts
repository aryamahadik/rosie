// T-1561: what db/repo's readStagingTestBusinesses (K-05 v1.24 item 89) checks before any statement. No database: every
// read here is sent through a client that throws the moment it is touched, so a request the call refuses is shown
// refused before any statement (a TypeError naming its field, never a number), and a request it accepts is shown to
// reach the client (the client's own error, never a TypeError). What the read answers is
// db/repo/staging-test-businesses.int.test.ts's.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Sql } from "./scope";
import { readStagingTestBusinesses, type ReadStagingTestBusinessesRequest } from "./staging-test-businesses";

const FIXTURES = new URL("../../contracts/data-access/fixtures/", import.meta.url);
const SENT = "a statement was sent";
const TP_01 = "+15555550100";
const TP_02 = "+15555550101";

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
    await readStagingTestBusinesses(untouched, request as ReadStagingTestBusinessesRequest);
  } catch (error) {
    return error;
  }
  return null;
}

describe("readStagingTestBusinesses before any statement (K-05 v1.24 item 89)", () => {
  it("sends read-staging-test-businesses-sam's request, and a list of one, on to the client", async () => {
    for (const request of [requestOf("read-staging-test-businesses-sam.json"), { numbers: [TP_01] }]) {
      const error = await thrownBy(request);
      expect(error).not.toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(SENT);
    }
  });

  it("refuses refuse-staging-test-businesses-no-numbers's empty list before any statement", async () => {
    const error = await thrownBy(requestOf("invalid/refuse-staging-test-businesses-no-numbers.json"));
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(
      "readStagingTestBusinesses: numbers is a list of at least one number",
    );
  });

  it("refuses a request of the wrong shape with a TypeError naming the field, never a number", async () => {
    const list = "numbers is a list of at least one number";
    const each = "each of numbers is a phone number in E.164 form";
    const refused: [unknown, string][] = [
      [null, "the request is an object"],
      [[TP_01], "the request is an object"],
      [{}, list],
      [{ numbers: [] }, list],
      [{ numbers: TP_01 }, list],
      [{ numbers: null }, list],
      [{ numbers: ["5555550100"] }, each],
      [{ numbers: [TP_01, "(555) 555-0101"] }, each],
      [{ numbers: [TP_01, 15555550101] }, each],
      [{ numbers: [TP_01, TP_02, TP_01] }, "numbers names each number once"],
      [{ numbers: [TP_01], businessIds: ["biz-lees-barbershop"] }, "the request takes only numbers"],
    ];
    for (const [request, message] of refused) {
      const error = await thrownBy(request);
      expect(error, message).toBeInstanceOf(TypeError);
      const text = (error as Error).message;
      expect(text).toBe(`readStagingTestBusinesses: ${message}`);
      for (const number of [TP_01, TP_02, "5555550100"]) {
        expect(text.includes(number)).toBe(false);
      }
    }
  });
});
