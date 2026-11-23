// Doubles for the ID upload tests (T-321). Never imported by the Worker. No database and no R2: K-22 v1's id_uploads read
// from the frozen seed fixture seed-owner-id-upload (Sam's ID photo at sign-up), read without its object key as the
// service reads it, and K-13 v1's checkUpload answered from K-13's own exchange fixtures (check-upload-stored: Sam's ID
// photo; check-upload-not-stored; check-upload-wrong-type), each request written down. Values come only from the
// contracts' fixtures and the master's sample cast, never a real person (rule 9).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type * as K13 from "../../../../../contracts/generated/port-files/port-files.v1";
import { seedRows } from "../test-support";
import {
  ID_UPLOAD_PURPOSES,
  type IdFilesPort,
  type IdUploadOnFile,
  type IdUploadReader,
  type PendingIdUpload,
} from "./id-upload";

/** K-22's seed of Sam's ID upload at sign-up, with its account (and K-04's people and roles before it). */
export const ID_UPLOAD_SEED = "people-access/fixtures/seed-owner-id-upload.json";

/** K-13 v1's fixtures folder. */
const K13_FIXTURES = fileURLToPath(new URL("../../../../../contracts/port-files/fixtures/", import.meta.url));

/** One K-13 v1 exchange fixture, by its file name, as parsed. */
export function k13Exchange(file: string): unknown {
  return JSON.parse(readFileSync(`${K13_FIXTURES}${file}`, "utf8"));
}

type Values = Readonly<Record<string, unknown>>;

function text(values: Values, column: string): string {
  const value = values[column];
  if (typeof value !== "string") throw new Error(`seed column ${column} is not text`);
  return value;
}

/** Every value a test must never see in an answer or an error: the seed's sealed object keys, as the rows hold them. */
export interface IdUploadRecord {
  readonly rows: readonly IdUploadOnFile[];
  readonly sealedKeys: readonly string[];
}

/** K-22's id_uploads rows of seed rows, as the data-access read answers them: every column but the object key. */
export function idUploadRecordOf(rows: readonly { table: string; values: Values }[]): IdUploadRecord {
  const uploads: IdUploadOnFile[] = [];
  const sealedKeys: string[] = [];
  for (const { table, values } of rows) {
    if (table !== "id_uploads") continue;
    const purpose = ID_UPLOAD_PURPOSES.find((one) => one === values.purpose);
    if (purpose === undefined) throw new Error("seed column purpose is not one of its values");
    uploads.push({
      id: text(values, "id"),
      personId: text(values, "person_id"),
      purpose,
      contentType: text(values, "content_type"),
      uploadedAt: text(values, "uploaded_at"),
    });
    sealedKeys.push(text(values, "object_key"));
  }
  return { rows: uploads, sealedKeys };
}

/** The record of ID_UPLOAD_SEED. */
export function seedIdUploads(): IdUploadRecord {
  return idUploadRecordOf(seedRows([ID_UPLOAD_SEED]));
}

/** No upload on file for anyone: before Sam's ID upload. */
export const NOTHING_UPLOADED: IdUploadRecord = { rows: [], sealedKeys: [] };

/** A row built for a test's own example. */
export function uploadRow(
  id: string,
  personId: string,
  purpose: IdUploadOnFile["purpose"],
  uploadedAt: string,
  contentType = "image/jpeg",
): IdUploadOnFile {
  return { id, personId, purpose, contentType, uploadedAt };
}

/** K-22's id_uploads by person; each person asked is written down. */
export function idUploadReaderOf(rows: readonly IdUploadOnFile[], asked: string[] = []): IdUploadReader {
  return {
    idUploadsOfPerson(personId) {
      asked.push(personId);
      return Promise.resolve(rows.filter((row) => row.personId === personId));
    },
  };
}

/** A reader with no row-level security: every person's rows, whatever it is asked. */
export function leakyIdUploadReaderOf(rows: readonly IdUploadOnFile[]): IdUploadReader {
  return { idUploadsOfPerson: () => Promise.resolve(rows) };
}

// ---- K-13 v1 ---------------------------------------------------------------------------------------------------------

type CheckUploadOutcome = K13.CheckUploadResult | K13.CheckUploadErrors;

/** K-13 v1 upload-id-document.json: Sam's ID photo link, its key kept on the server with upload-sam-id-1 (K-21 v1). */
export function samIdUpload(): PendingIdUpload {
  const exchange = k13Exchange("upload-id-document.json") as K13.UploadLinkExchange;
  if (!("result" in exchange.outcome)) throw new Error("upload-id-document.json is not ready");
  return {
    uploadId: "upload-sam-id-1",
    kind: exchange.request.kind,
    owner: exchange.request.owner,
    objectKey: exchange.outcome.objectKey,
    mediaType: exchange.request.mediaType,
  };
}

/** A K-13 checkUpload outcome from one of K-13's exchange fixtures. */
export function checkUploadOutcome(file: string): CheckUploadOutcome {
  const exchange = k13Exchange(file) as { readonly call: string; readonly outcome: CheckUploadOutcome };
  if (exchange.call !== "checkUpload") throw new Error(`${file} is not a checkUpload exchange`);
  return exchange.outcome;
}

/** K-13's stored answer for Sam's ID photo (check-upload-stored.json). */
export const STORED = (): CheckUploadOutcome => checkUploadOutcome("check-upload-stored.json");
/** K-13's notStored answer (check-upload-not-stored.json). */
export const NOT_STORED = (): CheckUploadOutcome => checkUploadOutcome("check-upload-not-stored.json");
/** K-13's wrongType answer, the file removed (check-upload-wrong-type.json). */
export const WRONG_TYPE = (): CheckUploadOutcome => checkUploadOutcome("check-upload-wrong-type.json");
/** K-13's tooLarge answer for a checkUpload, the file removed (K-13 v1 checkUpload.errors; no fixture of its own). */
export const TOO_LARGE = (): CheckUploadOutcome => ({
  error: "tooLarge",
  maxBytes: 10485760,
  sizeBytes: 10485761,
  removed: true,
});
/** K-13's unavailable answer (error-unavailable.json's outcome, which every call may give). */
export const UNAVAILABLE = (): CheckUploadOutcome =>
  (k13Exchange("error-unavailable.json") as { readonly outcome: K13.FilesUnavailableError }).outcome;

/**
 * Every call of K-13 v1, the double answering checkUpload with `outcome` and writing each request down. The other five
 * calls (the file's bytes by serverRead, a person's view by readLink, and the rest) throw: a face match would need the
 * bytes, a video check a person viewing the ID, and C10 runs neither.
 */
export interface FilesDouble extends IdFilesPort {
  readonly checked: K13.CheckUploadRequest[];
  uploadLink(): never;
  readLink(): never;
  serverWrite(): never;
  serverRead(): never;
  deleteObject(): never;
}

export function filesAnswering(outcome: CheckUploadOutcome): FilesDouble {
  const checked: K13.CheckUploadRequest[] = [];
  const never = (call: string) => (): never => {
    throw new Error(`the ID upload must not call K-13 ${call}`);
  };
  return {
    checked,
    checkUpload(request) {
      checked.push(request);
      return Promise.resolve(outcome);
    },
    uploadLink: never("uploadLink"),
    readLink: never("readLink"),
    serverWrite: never("serverWrite"),
    serverRead: never("serverRead"),
    deleteObject: never("deleteObject"),
  };
}

/** A view of `target` that writes down every property read from it, in order, so a test sees all that was reached. */
export function recording<T extends object>(target: T, touched: string[]): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      touched.push(String(property));
      return Reflect.get(object, property, receiver) as unknown;
    },
  });
}
