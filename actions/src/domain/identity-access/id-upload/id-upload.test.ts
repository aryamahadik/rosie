// T-321's ID upload proofs (the card's "Proves it with"), on K-22 v1's seed seed-owner-id-upload and K-13 v1's exchange
// fixtures, through in-memory doubles, never a database or R2:
//   - seed-owner-id-upload.json counts as "the ID confirmed" (MC C10); no upload on file is not confirmed;
//   - no face match or video check is called (C10): the only port call is K-13 checkUpload, never the file's bytes or a
//     person's view of it.
// And the rest of C10 and S13-45 row 8: an upload recorded only once checkUpload answers stored, as the row the commit
// writes with id_checked; the re-check as the second proof; and nothing private in an answer or an error.

import { describe, expect, it } from "vitest";

import {
  ID_CHECKED,
  IdUploadNotWiredError,
  IdUploadPortError,
  IdUploadReadError,
  createIdUploadAccess,
  idConfirmedOf,
  idReCheckedOf,
  type ConfirmUploadRequest,
  type IdFilesPort,
  type IdUploadAccess,
  type IdUploadOnFile,
  type PendingIdUpload,
} from "./id-upload";
import {
  NOTHING_UPLOADED,
  NOT_STORED,
  STORED,
  TOO_LARGE,
  UNAVAILABLE,
  WRONG_TYPE,
  filesAnswering,
  idUploadReaderOf,
  leakyIdUploadReaderOf,
  recording,
  samIdUpload,
  seedIdUploads,
  uploadRow,
} from "./test-support";

const SEED = seedIdUploads();

/** Sam's sign-up upload as T-636b's call would ask it: the link's person, K-13's pending upload, the row's id. */
function samSignUp(more: Partial<ConfirmUploadRequest> = {}): ConfirmUploadRequest {
  return {
    personId: "person-sam",
    purpose: "sign_up",
    upload: samIdUpload(),
    rowId: "idup-sam-sign-up",
    ...more,
  };
}

function access(rows: readonly IdUploadOnFile[], files?: IdFilesPort): IdUploadAccess {
  return createIdUploadAccess(
    files === undefined ? { reader: idUploadReaderOf(rows) } : { reader: idUploadReaderOf(rows), files },
  );
}

describe("the ID confirmed (MC C10; K-22 v1 id_uploads; S1-10, S1-32)", () => {
  it("seed-owner-id-upload.json counts as 'the ID confirmed': Sam's sign_up upload, accepted as given", async () => {
    expect(SEED.rows).toEqual([
      {
        id: "idup-sam-sign-up",
        personId: "person-sam",
        purpose: "sign_up",
        contentType: "image/jpeg",
        uploadedAt: "2026-10-19T14:10:00Z",
      },
    ]);
    expect(await access(SEED.rows).idConfirmed("person-sam")).toEqual({
      confirmed: true,
      uploadId: "idup-sam-sign-up",
      uploadedAt: "2026-10-19T14:10:00Z",
    });
  });

  it("no sign_up upload on file is not confirmed: before Sam's upload, and for anyone else", async () => {
    expect(await access(NOTHING_UPLOADED.rows).idConfirmed("person-sam")).toEqual({ confirmed: false });
    for (const personId of ["person-riley", "person-pat", "person-alex"]) {
      expect(await access(SEED.rows).idConfirmed(personId)).toEqual({ confirmed: false });
    }
  });

  it("any document counts, a photo or a PDF, and a re-check alone confirms no sign-up (default I1)", async () => {
    const pdf = [
      uploadRow("idup-riley-sign-up", "person-riley", "sign_up", "2026-10-20T09:00:00Z", "application/pdf"),
    ];
    expect(await access(pdf).idConfirmed("person-riley")).toEqual({
      confirmed: true,
      uploadId: "idup-riley-sign-up",
      uploadedAt: "2026-10-20T09:00:00Z",
    });
    const reCheckOnly = [
      uploadRow("idup-riley-re-check", "person-riley", "re_check", "2026-10-21T09:00:00Z"),
    ];
    expect(await access(reCheckOnly).idConfirmed("person-riley")).toEqual({ confirmed: false });
  });

  it("another person's upload never confirms this person's ID, even from a reader that gives every row", async () => {
    const service = createIdUploadAccess({ reader: leakyIdUploadReaderOf(SEED.rows) });
    expect(await service.idConfirmed("person-riley")).toEqual({ confirmed: false });
    expect(idConfirmedOf(SEED.rows, "person-riley")).toEqual({ confirmed: false });
    expect(idConfirmedOf(SEED.rows, "person-sam")).toEqual({
      confirmed: true,
      uploadId: "idup-sam-sign-up",
      uploadedAt: "2026-10-19T14:10:00Z",
    });
  });
});

describe("the ID re-check, a second proof that isn't the phone (S13-45 row 8; C-094 'second proofs included')", () => {
  const ROWS = [
    ...SEED.rows,
    uploadRow("idup-sam-re-check-1", "person-sam", "re_check", "2026-10-28T10:00:00Z"),
    uploadRow("idup-sam-re-check-2", "person-sam", "re_check", "2026-10-30T10:00:00Z"),
  ];

  it("a re_check upload at or after the moment named counts as the ID re-check, the latest named", async () => {
    const service = access(ROWS);
    expect(await service.idReChecked("person-sam", "2026-10-28T10:00:00Z")).toEqual({
      reChecked: true,
      uploadId: "idup-sam-re-check-2",
      uploadedAt: "2026-10-30T10:00:00Z",
    });
    expect(await service.idReChecked("person-sam", "2026-10-30T10:00:00Z")).toEqual({
      reChecked: true,
      uploadId: "idup-sam-re-check-2",
      uploadedAt: "2026-10-30T10:00:00Z",
    });
  });

  it("an older re-check, the sign-up upload, or another person's re-check proves nothing new (default I2)", async () => {
    const service = access(ROWS);
    expect(await service.idReChecked("person-sam", "2026-10-30T10:00:01Z")).toEqual({ reChecked: false });
    expect(await access(SEED.rows).idReChecked("person-sam", "2026-10-01T00:00:00Z")).toEqual({
      reChecked: false,
    });
    expect(idReCheckedOf(ROWS, "person-riley", "2026-10-01T00:00:00Z")).toEqual({ reChecked: false });
  });
});

describe("recording an upload as the ID confirmed (C10; K-13 checkUpload; K-21 v1 finishUpload)", () => {
  it("a stored upload with none on file answers the sign_up row the commit writes, and gives id_checked", async () => {
    const files = filesAnswering(STORED());
    const answer = await access(NOTHING_UPLOADED.rows, files).confirmUpload(samSignUp());
    expect(answer).toEqual({
      outcome: "record",
      row: {
        id: "idup-sam-sign-up",
        personId: "person-sam",
        purpose: "sign_up",
        objectKey: "idDocument/2026-10-19/q7m2k9x4t8v1c6b3n5p0r2s4w6",
        contentType: "image/jpeg",
        uploadedAt: "2026-10-19T14:30:41Z",
      },
      gives: [ID_CHECKED],
    });
    expect(files.checked).toEqual([
      {
        objectKey: "idDocument/2026-10-19/q7m2k9x4t8v1c6b3n5p0r2s4w6",
        mediaType: "image/jpeg",
        maxBytes: 10485760,
      },
    ]);
  });

  it("the recorded row then counts as the ID confirmed", async () => {
    const answer = await access(NOTHING_UPLOADED.rows, filesAnswering(STORED())).confirmUpload(samSignUp());
    if (answer.outcome !== "record") throw new Error("not recorded");
    const written: IdUploadOnFile = {
      id: answer.row.id,
      personId: answer.row.personId,
      purpose: answer.row.purpose,
      contentType: answer.row.contentType,
      uploadedAt: answer.row.uploadedAt,
    };
    expect(await access([written]).idConfirmed("person-sam")).toEqual({
      confirmed: true,
      uploadId: "idup-sam-sign-up",
      uploadedAt: "2026-10-19T14:30:41Z",
    });
  });

  it("nothing is recorded unless checkUpload answers stored: not stored, refused, unavailable", async () => {
    const cases = [
      [NOT_STORED(), { outcome: "notStored" }],
      [WRONG_TYPE(), { outcome: "refused", error: "wrongType" }],
      [TOO_LARGE(), { outcome: "refused", error: "tooLarge" }],
      [UNAVAILABLE(), { outcome: "unavailable" }],
    ] as const;
    for (const [checked, expected] of cases) {
      expect(await access(NOTHING_UPLOADED.rows, filesAnswering(checked)).confirmUpload(samSignUp())).toEqual(
        expected,
      );
    }
  });

  it("a sign_up already on file stands: nothing new recorded and the port not asked (default I3)", async () => {
    const files = filesAnswering(STORED());
    for (const rowId of ["idup-sam-sign-up", "idup-sam-second"]) {
      expect(await access(SEED.rows, files).confirmUpload(samSignUp({ rowId }))).toEqual({
        outcome: "alreadyConfirmed",
        uploadId: "idup-sam-sign-up",
      });
    }
    expect(files.checked).toEqual([]);
  });

  it("a re_check upload is recorded beside the sign-up, as the re-check, and gives nothing", async () => {
    const answer = await access(SEED.rows, filesAnswering(STORED())).confirmUpload(
      samSignUp({ purpose: "re_check", rowId: "idup-sam-re-check" }),
    );
    expect(answer).toEqual({
      outcome: "record",
      row: {
        id: "idup-sam-re-check",
        personId: "person-sam",
        purpose: "re_check",
        objectKey: "idDocument/2026-10-19/q7m2k9x4t8v1c6b3n5p0r2s4w6",
        contentType: "image/jpeg",
        uploadedAt: "2026-10-19T14:30:41Z",
      },
      gives: [],
    });
  });

  it("only the person's own ID document, with no business, is an ID upload: refused before the port is asked", async () => {
    const files = filesAnswering(STORED());
    const service = access(NOTHING_UPLOADED.rows, files);
    const sam = samIdUpload();
    const cases: [PendingIdUpload, string][] = [
      [{ ...sam, kind: "photo" }, "kind"],
      [{ ...sam, owner: { kind: "business", businessId: "biz-lees-barbershop" } }, "owner"],
      [
        { ...sam, owner: { kind: "person", personId: "person-sam", businessId: "biz-lees-barbershop" } },
        "owner",
      ],
      [{ ...sam, owner: { kind: "person", personId: "person-riley", businessId: null } }, "owner"],
      [{ ...sam, mediaType: JSON.parse('"image/svg+xml"') as PendingIdUpload["mediaType"] }, "mediaType"],
    ];
    for (const [upload, why] of cases) {
      expect(await service.confirmUpload(samSignUp({ upload }))).toEqual({ outcome: "notAnIdUpload", why });
    }
    expect(files.checked).toEqual([]);
  });
});

describe("no face match or video check is called (C10)", () => {
  it("the only port call is checkUpload: never the file's bytes (serverRead) nor a person's view (readLink)", async () => {
    const touchedOptions: string[] = [];
    const touchedFiles: string[] = [];
    const touchedReader: string[] = [];
    const files = filesAnswering(STORED());
    const service = createIdUploadAccess(
      recording(
        {
          reader: recording(idUploadReaderOf(NOTHING_UPLOADED.rows), touchedReader),
          files: recording(files, touchedFiles),
        },
        touchedOptions,
      ),
    );
    const answer = await service.confirmUpload(samSignUp());
    expect(answer.outcome).toBe("record");
    expect(touchedOptions).toEqual(["reader", "files"]);
    expect(touchedFiles).toEqual(["checkUpload"]);
    expect(touchedReader).toEqual(["idUploadsOfPerson"]);
    expect(files.checked).toHaveLength(1);
  });

  it("confirming an ID reads no port at all, and its answer holds no face, selfie or video result", async () => {
    const touchedFiles: string[] = [];
    const service = createIdUploadAccess({
      reader: idUploadReaderOf(SEED.rows),
      files: recording(filesAnswering(STORED()), touchedFiles),
    });
    const confirmed = await service.idConfirmed("person-sam");
    await service.idReChecked("person-sam", "2026-10-01T00:00:00Z");
    expect(touchedFiles).toEqual([]);
    expect(Object.keys(confirmed).sort()).toEqual(["confirmed", "uploadId", "uploadedAt"]);
    const recorded = await access(NOTHING_UPLOADED.rows, filesAnswering(STORED())).confirmUpload(samSignUp());
    expect(JSON.stringify(recorded)).not.toMatch(/face|selfie|video|match/i);
  });
});

describe("refusals, and nothing private in an answer or an error", () => {
  it("with no files port bound, confirmUpload refuses before anything is read", async () => {
    const asked: string[] = [];
    const service = createIdUploadAccess({ reader: idUploadReaderOf(SEED.rows, asked) });
    await expect(service.confirmUpload(samSignUp())).rejects.toThrow(new IdUploadNotWiredError());
    expect(asked).toEqual([]);
  });

  it("a request of the wrong shape is refused naming the field, never the object key", async () => {
    const service = access(NOTHING_UPLOADED.rows, filesAnswering(STORED()));
    const key = samIdUpload().objectKey;
    const refusals: [ConfirmUploadRequest, string][] = [
      [samSignUp({ personId: "" }), "personId must be a non-empty id"],
      [samSignUp({ rowId: " " }), "rowId must be a non-empty id"],
      [samSignUp({ purpose: JSON.parse('"selfie"') as "sign_up" }), "purpose must be sign_up or re_check"],
      [samSignUp({ upload: { ...samIdUpload(), uploadId: "" } }), "uploadId must be a non-empty id"],
      [samSignUp({ upload: { ...samIdUpload(), objectKey: "" } }), "objectKey must be a non-empty key"],
    ];
    for (const [request, message] of refusals) {
      const error: unknown = await service.confirmUpload(request).catch((caught: unknown) => caught);
      expect(error).toEqual(new TypeError(message));
      expect(String(error)).not.toContain(key);
    }
    await expect(service.idConfirmed("")).rejects.toThrow(new TypeError("personId must be a non-empty id"));
    await expect(service.idReChecked("person-sam", "Oct 28")).rejects.toThrow(
      new TypeError("since must be an instant in UTC"),
    );
  });

  it("a stored answer outside K-13 v1 records nothing and names the field, never the key (default I4)", async () => {
    const stored = STORED();
    const cases: [unknown, string][] = [
      [{ ...stored, mediaType: "image/png" }, "mediaType"],
      [{ ...stored, storedAt: "yesterday" }, "storedAt"],
      [{ result: "maybe" }, "result"],
    ];
    const key = samIdUpload().objectKey;
    for (const [checked, field] of cases) {
      const files = filesAnswering(checked as ReturnType<typeof STORED>);
      const error: unknown = await access(NOTHING_UPLOADED.rows, files)
        .confirmUpload(samSignUp())
        .catch((caught: unknown) => caught);
      expect(error).toEqual(new IdUploadPortError(field));
      expect(String(error)).not.toContain(key);
    }
  });

  it("a row of the person outside K-22's lists fails closed naming the column (default I5)", async () => {
    const badTime = [uploadRow("idup-sam-sign-up", "person-sam", "sign_up", "Oct 19")];
    await expect(access(badTime).idConfirmed("person-sam")).rejects.toThrow(
      new IdUploadReadError("id_uploads.uploaded_at"),
    );
    const badPurpose = [
      {
        ...uploadRow("idup-sam-x", "person-sam", "sign_up", "2026-10-19T14:10:00Z"),
        purpose: JSON.parse('"face"') as "sign_up",
      },
    ];
    await expect(access(badPurpose).idConfirmed("person-sam")).rejects.toThrow(
      new IdUploadReadError("id_uploads.purpose"),
    );
  });

  it("no answer carries the seed's sealed object key, and every answer is ids, labels and times", async () => {
    expect(SEED.sealedKeys).toHaveLength(1);
    const service = access(SEED.rows, filesAnswering(STORED()));
    const answers = [
      await service.idConfirmed("person-sam"),
      await service.idReChecked("person-sam", "2026-10-01T00:00:00Z"),
      await service.confirmUpload(samSignUp()),
      SEED.rows,
    ];
    const text = JSON.stringify(answers);
    for (const sealed of SEED.sealedKeys) expect(text).not.toContain(sealed);
  });
});
