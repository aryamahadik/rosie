// T-1573: what db/repo's readPendingUpload (K-05 v1.24 item 86) and readUploadFinishedAt (K-05 v1.25 item 94) check
// before any statement. No database: every read here is sent through a client that throws the moment it is touched, so
// a request a call refuses is shown refused before any statement (a TypeError naming its field, never its value), and a
// request it accepts is shown to reach the client (the client's own error, never a TypeError). What the reads answer is
// db/repo/pending-uploads.int.test.ts's.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  readPendingUpload,
  type ReadPendingUploadRequest,
  readUploadFinishedAt,
  type ReadUploadFinishedAtRequest,
} from "./pending-uploads";
import type { Sql } from "./scope";

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

type Read = (request: unknown) => Promise<unknown>;

const READS: { call: string; read: Read; fixtures: string[] }[] = [
  {
    call: "readPendingUpload",
    read: (request) => readPendingUpload(untouched, request as ReadPendingUploadRequest),
    fixtures: ["read-pending-upload-sam-id.json", "read-pending-upload-unknown.json"],
  },
  {
    call: "readUploadFinishedAt",
    read: (request) => readUploadFinishedAt(untouched, request as ReadUploadFinishedAtRequest),
    fixtures: ["read-upload-finished-demo-owner.json", "read-upload-finished-unknown.json"],
  },
];

async function thrownBy(read: Read, request: unknown): Promise<unknown> {
  try {
    await read(request);
  } catch (error) {
    return error;
  }
  return null;
}

for (const { call, read, fixtures } of READS) {
  describe(`${call} before any statement (K-05 items 86 and 94)`, () => {
    it("sends each fixture's request on to the client", async () => {
      for (const file of fixtures) {
        const error = await thrownBy(read, requestOf(file));
        expect(error, file).not.toBeInstanceOf(TypeError);
        expect((error as Error).message, file).toBe(SENT);
      }
    });

    it("refuses a request of the wrong shape with a TypeError naming the field, never its value", async () => {
      const objectKey = "\\x5ea1ed0b1ec70a1b2c3d";
      const refused: [unknown, string][] = [
        [undefined, `${call}: the request is an object`],
        [null, `${call}: the request is an object`],
        ["upload-sam-id", `${call}: the request is an object`],
        [["upload-sam-id"], `${call}: the request is an object`],
        [{}, `${call}: uploadId is an upload id, a non-empty text`],
        [{ uploadId: "" }, `${call}: uploadId is an upload id, a non-empty text`],
        [{ uploadId: null }, `${call}: uploadId is an upload id, a non-empty text`],
        [{ uploadId: 7 }, `${call}: uploadId is an upload id, a non-empty text`],
        [{ uploadId: "upload\u0000sam" }, `${call}: uploadId is an upload id, a non-empty text`],
        [{ uploadId: "upload-sam-id", objectKey }, `${call}: the request takes only uploadId`],
        [
          { uploadId: "upload-sam-id", businessId: "biz-lees-barbershop" },
          `${call}: the request takes only uploadId`,
        ],
      ];
      for (const [request, message] of refused) {
        const error = await thrownBy(read, request);
        expect(error, message).toBeInstanceOf(TypeError);
        expect((error as Error).message).toBe(message);
        expect((error as Error).message.includes(objectKey)).toBe(false);
      }
    });
  });
}
