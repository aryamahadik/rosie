// T-437: the files double against K-13 v1's fixtures and schema (contracts/port-files). No network and no key. Every
// id, key and address here is one of K-13 v1's fixtures' or a placeholder of the same kind (the master's sample cast and
// fixture set v1's demo shops: Sam, Riley, Alex, Jordan; Lee's Barbershop and Lee Home Services), never a real person's
// (rule 9). The files' bytes are made here: a signature and zeros, never a real photo or paper.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";

import { spanLogLine, type OutsideCallSpan } from "../../shared/spans";
import {
  FILE_KINDS,
  FilesRequestRefused,
  IMAGE_TYPES,
  newKeyId,
  sha256Hex,
  UPLOAD_KINDS,
  UPLOAD_MAX_BYTES,
  UPLOAD_MEDIA_TYPES,
  type BookingOwner,
  type FileKind,
  type FilesCall,
  type FilesCallName,
  type FilesPort,
  type FilesTrace,
  type MediaType,
  type ReadLinkRequest,
  type ServerWriteRequest,
  type UploadKind,
  type UploadLinkReady,
  type UploadLinkRequest,
  type UploadMediaType,
  type UploadOwner,
} from "../port";
import { createFilesDouble, DOUBLE_LINK_HOST, FILES_DOUBLE_TRACE, type FilesDouble } from "./double";

const CONTRACTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "contracts",
);
const FIXTURES = path.join(CONTRACTS, "port-files", "fixtures");
const SCHEMA_ID = "https://rosie.invalid/contracts/port-files/port-files.v1.schema.json";

interface Exchange {
  call: FilesCallName;
  given: { now: string; note: string };
  request: Record<string, unknown>;
  outcome: Record<string, unknown>;
}

interface IndexEntry {
  file: string;
  version: string;
  def: string;
  expect: "accept" | "refuse";
}

interface SpanFixture {
  trace_id: string;
  span_id: string;
  seq: number;
  at: string;
  bundle_id: { hash: string; build: number };
  turn_id: string | null;
  job_id: string | null;
  handle_ref: string | null;
  business_id: string | null;
  attempt: number;
  got: { step?: string };
}

const readJson = (...parts: string[]): unknown =>
  JSON.parse(readFileSync(path.join(...parts), "utf8")) as unknown;
const exchange = (file: string): Exchange => readJson(FIXTURES, file) as Exchange;
const INDEX = (readJson(FIXTURES, "index.json") as { fixtures: IndexEntry[] }).fixtures;
const v1 = INDEX.filter((entry) => entry.version === "v1");
const ACCEPTED_EXCHANGES = v1
  .filter((entry) => entry.expect === "accept" && entry.def.endsWith(".exchange"))
  .map((entry) => entry.file);
const SPAN_FIXTURES = v1
  .filter((entry) => entry.expect === "accept" && entry.def === "filesSpan")
  .map((e) => e.file);
const REFUSED_FIXTURES = v1.filter((entry) => entry.expect === "refuse");

let ajv: Ajv2020;

beforeAll(() => {
  ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  const folders = readdirSync(CONTRACTS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !["scripts", "generated", "node_modules"].includes(entry.name))
    .map((entry) => entry.name);
  for (const folder of folders)
    for (const file of readdirSync(path.join(CONTRACTS, folder)))
      if (file.endsWith(".schema.json")) ajv.addSchema(readJson(CONTRACTS, folder, file) as object);
});

function validator(def: string): ValidateFunction {
  const check = ajv.getSchema(`${SCHEMA_ID}#/$defs/${def}`);
  if (check === undefined) throw new Error(`port-files v1 has no ${def}`);
  return check;
}

function accepts(def: string, value: unknown): void {
  const check = validator(def);
  expect(check(value), JSON.stringify(check.errors)).toBe(true);
}

/** The double's answer as the exchange K-13 v1's schema checks, with a placeholder `given`. */
function expectExchange(call: FilesCallName, request: unknown, outcome: unknown): void {
  accepts(`${call}.exchange`, {
    call,
    given: { now: "2026-10-19T14:30:30Z", note: "the double's answer" },
    request,
    outcome,
  });
}

function expectSpan(span: OutsideCallSpan): void {
  accepts("filesSpan", span);
}

// ---- the files' bytes: a signature, then zeros ----

const SIGNATURES: Record<UploadMediaType, number[]> = {
  "image/jpeg": [0xff, 0xd8, 0xff, 0xe0],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/webp": [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
  // An ftyp box of 24 bytes: major brand heic, version 0, compatible mif1 and heic.
  "image/heic": [
    0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x68,
    0x65, 0x69, 0x63,
  ],
  // An ftyp box of 20 bytes: major brand mif1, compatible mif1 only.
  "image/heif": [
    0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31,
  ],
  // "%PDF-1.7"
  "application/pdf": [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37],
};

function fileOf(type: UploadMediaType, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(SIGNATURES[type].slice(0, size));
  return bytes;
}

/** Bytes of one size for a server write, numbered so two writes of one size differ by `seed`. */
function bodyOf(size: number, seed = 1): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes[0] = seed;
  bytes[size - 1] = seed;
  return bytes;
}

/** A server write fixture's request with its own body: the fixture's sha256 hashes no bytes (README "Fixtures"). */
async function writeOf(file: string, seed = 1): Promise<{ request: ServerWriteRequest; body: Uint8Array }> {
  const fx = exchange(file);
  const request = structuredClone(fx.request) as unknown as ServerWriteRequest;
  const body = bodyOf(request.sizeBytes, seed);
  return { request: { ...request, sha256: await sha256Hex(body) }, body };
}

// ---- a double the test drives: its clock, the next key ids and the next link addresses ----

interface Driven {
  double: FilesDouble;
  at(now: string): void;
  ids: string[];
  urls: string[];
}

function driven(start = "2026-10-19T14:00:00Z"): Driven {
  let now = start;
  const ids: string[] = [];
  const urls: string[] = [];
  const double = createFilesDouble({
    now: () => now,
    newId: () => ids.shift() ?? newKeyId(),
    linkUrl: (use) => urls.shift() ?? `${DOOR}/${use}/${newKeyId()}`,
  });
  return {
    double,
    at: (next: string) => {
      now = next;
    },
    ids,
    urls,
  };
}

const DOOR = DOUBLE_LINK_HOST;

/** An object stored by an upload: the link, the PUT and the check, as the page entry and the browser would. */
async function uploaded(
  d: Driven,
  setup: {
    kind: UploadKind;
    owner: UploadOwner;
    mediaType: UploadMediaType;
    sizeBytes: number;
    id?: string;
    at: string;
  },
): Promise<string> {
  d.at(setup.at);
  if (setup.id !== undefined) d.ids.push(setup.id);
  const ready = readyOf(
    await d.double.uploadLink({
      kind: setup.kind,
      owner: setup.owner,
      mediaType: setup.mediaType,
      sizeBytes: setup.sizeBytes,
      visibility: "private",
      lifeSeconds: 900,
    }),
  );
  expect(await d.double.put(ready.url, fileOf(setup.mediaType, setup.sizeBytes), setup.mediaType)).toEqual({
    result: "stored",
    status: 200,
  });
  expect(
    await d.double.checkUpload({
      objectKey: ready.objectKey,
      mediaType: setup.mediaType,
      maxBytes: UPLOAD_MAX_BYTES,
    }),
  ).toMatchObject({ result: "stored", sizeBytes: setup.sizeBytes });
  return ready.objectKey;
}

function readyOf(outcome: unknown): UploadLinkReady {
  if (typeof outcome !== "object" || outcome === null || !("result" in outcome) || outcome.result !== "ready")
    throw new Error("the upload link was not made");
  return outcome as UploadLinkReady;
}

async function refusal(work: Promise<unknown>): Promise<FilesRequestRefused> {
  try {
    await work;
  } catch (error) {
    if (error instanceof FilesRequestRefused) return error;
    throw error;
  }
  throw new Error("the request was not refused");
}

function only<T>(list: readonly T[]): T {
  expect(list).toHaveLength(1);
  const [item] = list;
  if (item === undefined) throw new Error("the list is empty");
  return item;
}

const SAM: UploadOwner = { kind: "person", personId: "person-sam", businessId: null };
const LEES: UploadOwner = { kind: "business", businessId: "biz-lees-barbershop" };
const RILEY_AT_LEES: UploadOwner = {
  kind: "person",
  personId: "person-riley",
  businessId: "biz-lees-barbershop",
};
const ALEX_HEATER: BookingOwner = {
  kind: "booking",
  businessId: "biz-lee-home-services",
  bookingId: "booking-alex-water-heater",
  personId: "person-alex",
};
const RILEY_LICENSE = "licenseFile/2026-10-19/r1l3y8b4r5l9c2n6s0p7h3t5k1";
const LEES_FRONT = "photo/2026-10-19/f9r2n7t4s1h6p3o8m5c0k2x7v4";
const LOG = { level: "info", environment: "staging", version: "test-sha" } as const;

/** Every fixture's object key (and its random part), writeId, link address and file hash: none may reach a span or a log. */
function secretsOfFixtures(): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, name: string): void => {
    if (typeof value === "string") {
      if (name === "objectKey") found.add(value).add(value.slice(-26));
      if (name === "url" || name === "sha256" || name === "writeId") found.add(value);
    } else if (typeof value === "object" && value !== null)
      for (const [inner, held] of Object.entries(value)) walk(held, inner);
  };
  for (const entry of v1) walk(readJson(FIXTURES, entry.file), "");
  return [...found];
}

describe("the card's checks (T-437 Proves it with)", () => {
  it("every K-13 v1 accepted exchange fixture gives exactly its outcome, replayed as one story on one double", async () => {
    const d = driven();
    const answered = new Set<string>();
    const replay = async (file: string, body?: Uint8Array, request?: unknown): Promise<unknown> => {
      const fx = exchange(file);
      const asked = request ?? fx.request;
      const outcome = await askOutcome(d.double, fx.call, asked, body);
      expect(outcome, file).toEqual(fx.outcome);
      expectExchange(fx.call, asked, outcome);
      answered.add(file);
      return outcome;
    };

    // S1-10: Sam's ID document, its link, the browser's PUT at 14:30:41 and the check.
    d.at("2026-10-19T14:30:30Z");
    d.ids.push("q7m2k9x4t8v1c6b3n5p0r2s4w6");
    d.urls.push("https://files.example.com/upload/placeholder-signed-sam-id-1");
    const samId = readyOf(await replay("upload-id-document.json"));
    d.at("2026-10-19T14:30:41Z");
    expect(await d.double.put(samId.url, fileOf("image/jpeg", 2_400_000), "image/jpeg")).toMatchObject({
      result: "stored",
    });
    d.at("2026-10-19T14:31:00Z");
    await replay("check-upload-stored.json");

    // S1-12: the price list's link, which lapses with no file sent.
    d.at("2026-10-19T14:40:00Z");
    d.ids.push("h3n8c5v2x7m4k9q1t6b0p3r8s5");
    d.urls.push("https://files.example.com/upload/placeholder-signed-lees-price-list-1");
    await replay("upload-price-list-photo.json");
    d.at("2026-10-19T14:56:00Z");
    await replay("check-upload-not-stored.json");

    // A4-07: Alex's photo over 10 MiB gets no link; a later JPEG link gets a PDF's bytes, which are refused and removed.
    d.at("2026-11-03T00:12:10Z");
    await replay("upload-too-large.json");
    d.at("2026-11-03T00:12:30Z");
    d.ids.push("w2r4o6n8g0t1y3p5e7k9x2c4v6");
    const heater = readyOf(
      await d.double.uploadLink({
        kind: "photo",
        owner: ALEX_HEATER,
        mediaType: "image/jpeg",
        sizeBytes: 3_100_000,
        visibility: "private",
        lifeSeconds: 600,
      }),
    );
    expect(await d.double.put(heater.url, fileOf("application/pdf", 3_100_000), "image/jpeg")).toMatchObject({
      result: "stored",
    });
    d.at("2026-11-03T00:13:00Z");
    await replay("check-upload-wrong-type.json");
    expect(d.double.objects()).not.toContain(heater.objectKey);

    // trace-sam-0009's sealed detail: the first try finds R2 unavailable, the second stores it.
    const sealed = await writeOf("server-write-sealed-trace.json");
    d.double.failNext();
    d.at("2026-10-19T14:12:35Z");
    await replay("error-unavailable.json", sealed.body, sealed.request);
    expect(d.double.objects()).not.toContain("sealedTrace/2026-10-19/t5r8c3s6q1w9e4a7d2f0g6h3j8");
    d.at("2026-10-19T14:12:40Z");
    await replay("server-write-sealed-trace.json", sealed.body, sealed.request);

    // The event log's rows of Oct 19 as one Parquet object, stored at 03:30:02 on Oct 20.
    const parquet = await writeOf("server-write-parquet.json");
    d.at("2026-10-20T03:30:02Z");
    await replay("server-write-parquet.json", parquet.body, parquet.request);

    // S1-12 by text: the photo written from its K-06 attachment, read by C-120, then the lost answer's retry.
    const linq = await writeOf("server-write-linq-photo.json");
    d.at("2026-10-19T14:20:03Z");
    await replay("server-write-linq-photo.json", linq.body, linq.request);
    d.at("2026-10-19T14:20:05Z");
    const read = await d.double.serverRead(exchange("server-read-photo.json").request);
    expect(read.outcome).toEqual(exchange("server-read-photo.json").outcome);
    expect(read.bytes).toEqual(linq.body);
    expectExchange("serverRead", exchange("server-read-photo.json").request, read.outcome);
    answered.add("server-read-photo.json");
    d.at("2026-10-19T14:20:09Z");
    await replay("server-write-repeat.json", linq.body, { ...linq.request });

    // B8-17's DONE photo and B10-19's camera report.
    const done = await writeOf("server-write-done-photo.json");
    d.at("2026-10-22T13:10:05Z");
    await replay("server-write-done-photo.json", done.body, done.request);
    const report = await writeOf("server-write-report.json");
    d.at("2026-10-23T12:40:04Z");
    await replay("server-write-report.json", report.body, report.request);

    // Riley's license photo: uploaded on Oct 19, seen by Sam on Oct 20, deleted for his erasure on Nov 2.
    await uploaded(d, {
      kind: "licenseFile",
      owner: RILEY_AT_LEES,
      mediaType: "image/jpeg",
      sizeBytes: 900_000,
      id: "r1l3y8b4r5l9c2n6s0p7h3t5k1",
      at: "2026-10-19T16:00:00Z",
    });
    d.at("2026-10-20T15:02:00Z");
    d.urls.push("https://files.example/read/placeholder-signed-riley-license-1");
    await replay("read-link-logged.json");

    // The listing's shop-front photo, uploaded on Oct 19 and shown to anyone on Oct 30.
    await uploaded(d, {
      kind: "photo",
      owner: LEES,
      mediaType: "image/jpeg",
      sizeBytes: 1_200_000,
      id: "f9r2n7t4s1h6p3o8m5c0k2x7v4",
      at: "2026-10-19T16:05:00Z",
    });
    d.at("2026-10-30T16:00:00Z");
    d.urls.push("https://files.example/placeholder-signed-read-front");
    await replay("read-link-listing-photo.json");

    d.at("2026-11-02T09:15:00Z");
    await replay("delete-erasure.json");
    d.at("2026-11-02T09:15:30Z");
    await replay("read-link-not-found.json");
    d.at("2026-11-02T09:16:00Z");
    await replay("delete-already-gone.json");
    expect(d.double.objects()).not.toContain(RILEY_LICENSE);

    expect([...answered].sort()).toEqual([...ACCEPTED_EXCHANGES].sort());
    expect(ACCEPTED_EXCHANGES).toHaveLength(19);
    for (const span of d.double.spans()) expectSpan(span);
  });

  it("refuse-public-object.json is refused by K-13 v1 and by the port: no link, no key, no span", async () => {
    const fx = exchange("invalid/refuse-public-object.json");
    expect(validator("uploadLink.exchange")(fx)).toBe(false);
    expect(validator("uploadLink.request")(fx.request)).toBe(false);
    const d = driven(fx.given.now);
    const refused = await refusal(d.double.uploadLink(fx.request));
    expect(refused.problems).toEqual(["request.visibility is not private (every object is private)"]);
    expect(d.double.spans()).toEqual([]);
    expect(d.double.requests()).toEqual([]);
    expect(d.double.objects()).toEqual([]);
    // With private, it is upload-price-list-photo.json, and every object is private.
    const key = await uploaded(d, {
      kind: "priceList",
      owner: LEES,
      mediaType: "image/jpeg",
      sizeBytes: 1_800_000,
      at: fx.given.now,
    });
    expect(d.double.objectInfo(key)).toMatchObject({ visibility: "private", came: "upload" });
    expect(d.double.get(`${DOOR}/${key}`)).toEqual({ result: "refused", status: 403, reason: "unknownLink" });
  });

  it("refuse-read-without-permission.json is refused by K-13 v1 and by the port: no link, no view, no span", async () => {
    const fx = exchange("invalid/refuse-read-without-permission.json");
    expect(validator("readLink.exchange")(fx)).toBe(false);
    expect(validator("readLink.request")(fx.request)).toBe(false);
    const d = driven();
    await uploaded(d, {
      kind: "licenseFile",
      owner: RILEY_AT_LEES,
      mediaType: "image/jpeg",
      sizeBytes: 900_000,
      id: "r1l3y8b4r5l9c2n6s0p7h3t5k1",
      at: "2026-10-19T16:00:00Z",
    });
    const spansBefore = d.double.spans().length;
    d.at(fx.given.now);
    const refused = await refusal(d.double.readLink(fx.request));
    expect(refused.problems).toEqual(["request.viewer is missing"]);
    expect(refused.message).not.toContain(RILEY_LICENSE);
    expect(d.double.spans()).toHaveLength(spansBefore);
    expect(d.double.views()).toEqual([]);
    // A null viewer, an empty one, or a person named on the listing's ground are no permission either.
    for (const viewer of [
      null,
      {},
      { as: "business" },
      { as: "business", personId: null },
      { as: "owner", personId: "person-sam" },
    ])
      await refusal(d.double.readLink({ ...fx.request, viewer }));
    expect(d.double.views()).toEqual([]);
    // With Sam as the viewer on the ground business, it is read-link-logged.json.
    const asked = { ...fx.request, viewer: { as: "business", personId: "person-sam" } };
    expect(await d.double.readLink(asked)).toMatchObject({
      result: "link",
      expiresAt: "2026-10-20T15:07:00Z",
    });
    expect(d.double.views()).toHaveLength(1);
  });

  it("a read link expires at its stated time: it serves the file before its end, never at it or after", async () => {
    const d = driven();
    const key = await uploaded(d, {
      kind: "licenseFile",
      owner: RILEY_AT_LEES,
      mediaType: "image/jpeg",
      sizeBytes: 900_000,
      at: "2026-10-19T16:00:00Z",
    });
    d.at("2026-10-20T15:02:00Z");
    const link = await d.double.readLink({
      objectKey: key,
      file: { table: "document_files", id: "docfile-riley-barber-license-photo" },
      viewer: { as: "business", personId: "person-sam" },
      lifeSeconds: 300,
    });
    if (!("result" in link)) throw new Error("no link was given");
    expect(link.expiresAt).toBe("2026-10-20T15:07:00Z");
    for (const now of ["2026-10-20T15:02:00Z", "2026-10-20T15:06:59Z", "2026-10-20T15:06:59.999Z"]) {
      d.at(now);
      expect(d.double.get(link.url), now).toMatchObject({ result: "served", status: 200 });
    }
    for (const now of ["2026-10-20T15:07:00Z", "2026-10-20T15:07:01Z", "2026-10-21T15:02:00Z"]) {
      d.at(now);
      expect(d.double.get(link.url), now).toEqual({ result: "refused", status: 403, reason: "expired" });
    }
    // Each life the caller may ask, from 1 to 15 minutes, ends exactly that long after the call.
    for (const lifeSeconds of [60, 600, 900]) {
      d.at("2026-10-20T16:00:00Z");
      const given = await d.double.readLink({
        objectKey: key,
        file: { table: "document_files", id: "docfile-riley-barber-license-photo" },
        viewer: { as: "self", personId: "person-riley" },
        lifeSeconds,
      });
      if (!("result" in given)) throw new Error("no link was given");
      expect(Date.parse(given.expiresAt) - Date.parse("2026-10-20T16:00:00Z")).toBe(lifeSeconds * 1000);
      d.at(new Date(Date.parse(given.expiresAt) - 1).toISOString());
      expect(d.double.get(given.url).result).toBe("served");
      d.at(given.expiresAt);
      expect(d.double.get(given.url).result).toBe("refused");
    }
    // An upload link ends the same way: the PUT is refused at its end.
    d.at("2026-10-20T17:00:00Z");
    const upload = readyOf(
      await d.double.uploadLink({
        kind: "form",
        owner: ALEX_HEATER,
        mediaType: "application/pdf",
        sizeBytes: 20_000,
        visibility: "private",
        lifeSeconds: 600,
      }),
    );
    expect(upload.expiresAt).toBe("2026-10-20T17:10:00Z");
    d.at(upload.expiresAt);
    expect(await d.double.put(upload.url, fileOf("application/pdf", 20_000), "application/pdf")).toEqual({
      result: "refused",
      status: 403,
      reason: "expired",
    });
    d.at("2026-10-20T17:10:01Z");
    expect(
      await d.double.checkUpload({
        objectKey: upload.objectKey,
        mediaType: "application/pdf",
        maxBytes: UPLOAD_MAX_BYTES,
      }),
    ).toEqual({
      result: "notStored",
    });
  });

  it("each read link on a view-logged kind writes one view record: who, on what ground, which row's file, when", async () => {
    const d = driven();
    // Under K-13 v1 every kind's read link is a view, logged by its span (README default 12; CQ-339's default).
    const keys = new Map<FileKind, string>();
    for (const kind of UPLOAD_KINDS) {
      const owner = kind === "idDocument" ? SAM : kind === "form" ? ALEX_HEATER : LEES;
      keys.set(
        kind,
        await uploaded(d, {
          kind,
          owner,
          mediaType: "image/png",
          sizeBytes: 4096,
          at: "2026-10-19T15:00:00Z",
        }),
      );
    }
    const writes: Record<
      Exclude<FileKind, UploadKind>,
      { mediaType: MediaType; owner: ServerWriteRequest["owner"] }
    > = {
      sealedTrace: { mediaType: "application/octet-stream", owner: { kind: "rosie" } },
      eventLogExport: { mediaType: "application/vnd.apache.parquet", owner: { kind: "rosie" } },
      export: { mediaType: "text/csv", owner: LEES },
      report: { mediaType: "video/mp4", owner: { ...ALEX_HEATER, bookingId: "booking-alex-drain" } },
    };
    for (const [kind, { mediaType, owner }] of Object.entries(writes) as [
      Exclude<FileKind, UploadKind>,
      (typeof writes)["report"],
    ][]) {
      const body = bodyOf(512);
      const written = await d.double.serverWrite(
        {
          kind,
          owner,
          mediaType,
          sizeBytes: 512,
          sha256: await sha256Hex(body),
          writeId: newKeyId(),
          day: "2026-10-19",
          visibility: "private",
          source: { kind: "rosie" },
        },
        body,
      );
      if (!("objectKey" in written)) throw new Error(`the ${kind} was not written`);
      keys.set(kind, written.objectKey);
    }
    expect([...keys.keys()].sort()).toEqual([...FILE_KINDS].sort());
    const spansBefore = d.double.spans().length;

    d.at("2026-10-21T10:00:00Z");
    for (const [kind, objectKey] of keys) {
      const viewer =
        kind === "idDocument"
          ? { as: "self", personId: "person-sam" }
          : { as: "rosieTeam", personId: "person-team-1" };
      const link = await d.double.readLink({
        objectKey,
        file: { table: "file_rows", id: `row-${kind}` },
        viewer,
        lifeSeconds: 120,
      });
      if (!("result" in link)) throw new Error(`no link for the ${kind}`);
      // Fetching the link twice in its short life is still one view: a view is the link's giving.
      expect(d.double.get(link.url).result).toBe("served");
      expect(d.double.get(link.url).result).toBe("served");
    }
    const views = d.double.views();
    expect(views).toHaveLength(FILE_KINDS.length);
    expect(views.map((view) => view.kind).sort()).toEqual([...FILE_KINDS].sort());
    for (const view of views) {
      expect(view).toMatchObject({
        at: "2026-10-21T10:00:00.000Z",
        fileTable: "file_rows",
        fileRow: `row-${view.kind}`,
        as: view.kind === "idDocument" ? "self" : "rosieTeam",
        viewer: view.kind === "idDocument" ? "person-sam" : "person-team-1",
      });
    }
    // Each view is its readLink span, which K-13 v1's filesSpan accepts: one span, one record.
    const readSpans = d.double.spans().slice(spansBefore);
    expect(readSpans).toHaveLength(FILE_KINDS.length);
    for (const span of readSpans) expectSpan(span);
    expect(views.map((view) => view.spanId)).toEqual(readSpans.map((span) => span.span_id));

    // A second read link is a second view; a listing view names no person.
    const front = keys.get("photo") ?? "";
    await d.double.readLink({
      objectKey: front,
      file: { table: "business_photos", id: "photo-lees-barbershop-front" },
      viewer: { as: "listing", personId: null },
      lifeSeconds: 600,
    });
    expect(d.double.views().at(-1)).toMatchObject({ kind: "photo", as: "listing", viewer: null });

    // No link, no view: a key with nothing under it, an unavailable call, and Rosie's own server read.
    const viewsBefore = d.double.views().length;
    const gone: ReadLinkRequest = {
      objectKey: "photo/2026-10-21/zzzzzzzzzzzzzzzzzzzzzzzzzz",
      file: { table: "business_photos", id: "photo-gone" },
      viewer: { as: "business", personId: "person-sam" },
      lifeSeconds: 60,
    };
    expect(await d.double.readLink(gone)).toEqual({ error: "notFound" });
    d.double.failNext();
    expect(await d.double.readLink({ ...gone, objectKey: front })).toEqual({ error: "unavailable" });
    expect((await d.double.serverRead({ objectKey: front, file: null })).outcome).toMatchObject({
      result: "read",
    });
    expect(d.double.views()).toHaveLength(viewsBefore);
    // And no view record holds a key or a link.
    const written = JSON.stringify(d.double.views());
    for (const key of keys.values()) expect(written).not.toContain(key.slice(-26));
    expect(written).not.toContain("https://");
  });
});

/** Asks the double one call with a request (and a body for a server write); the answer without the bytes. */
async function askOutcome(
  double: FilesPort,
  call: FilesCallName,
  request: unknown,
  body?: Uint8Array,
): Promise<unknown> {
  switch (call) {
    case "uploadLink":
      return double.uploadLink(request as UploadLinkRequest);
    case "checkUpload":
      return double.checkUpload(request as Parameters<FilesPort["checkUpload"]>[0]);
    case "readLink":
      return double.readLink(request as ReadLinkRequest);
    case "serverWrite":
      return double.serverWrite(request as ServerWriteRequest, body ?? new Uint8Array());
    case "serverRead":
      return (await double.serverRead(request as Parameters<FilesPort["serverRead"]>[0])).outcome;
    case "deleteObject":
      return double.deleteObject(request as Parameters<FilesPort["deleteObject"]>[0]);
  }
}

describe("every K-13 v1 fixture", () => {
  it("sorts each fixture of the index into exchanges, spans or refused ones", () => {
    expect(v1).toHaveLength(INDEX.length);
    const sorted = [...ACCEPTED_EXCHANGES, ...SPAN_FIXTURES, ...REFUSED_FIXTURES.map((entry) => entry.file)];
    expect([...sorted].sort()).toEqual(INDEX.map((entry) => entry.file).sort());
    expect([ACCEPTED_EXCHANGES.length, SPAN_FIXTURES.length, REFUSED_FIXTURES.length]).toEqual([19, 3, 10]);
  });

  it("refuses every refused fixture by its def, and the port never gives a refused outcome for its request", async () => {
    const d = driven();
    // The objects the refused reads and deletes name, so a read or delete the port allowed would find them.
    await uploaded(d, {
      kind: "licenseFile",
      owner: RILEY_AT_LEES,
      mediaType: "image/jpeg",
      sizeBytes: 900_000,
      id: RILEY_LICENSE.slice(-26),
      at: "2026-10-19T16:00:00Z",
    });
    await uploaded(d, {
      kind: "idDocument",
      owner: SAM,
      mediaType: "image/jpeg",
      sizeBytes: 2_400_000,
      id: "q7m2k9x4t8v1c6b3n5p0r2s4w6",
      at: "2026-10-19T14:30:30Z",
    });
    const refusedByPort: string[] = [];
    for (const entry of REFUSED_FIXTURES) {
      const value = readJson(FIXTURES, entry.file);
      expect(validator(entry.def)(value), entry.file).toBe(false);
      if (!entry.def.endsWith(".exchange")) continue;
      const fx = value as Exchange;
      d.at(fx.given.now);
      const spansBefore = d.double.spans().length;
      const objectsBefore = d.double.objects();
      try {
        const outcome = await askOutcome(d.double, fx.call, fx.request);
        expect(outcome, entry.file).not.toEqual(fx.outcome);
        expectExchange(fx.call, fx.request, outcome);
      } catch (error) {
        expect(error, entry.file).toBeInstanceOf(FilesRequestRefused);
        expect(validator(`${fx.call}.request`)(fx.request), entry.file).toBe(false);
        expect(d.double.spans(), entry.file).toHaveLength(spansBefore);
        expect(d.double.objects(), entry.file).toEqual(objectsBefore);
        refusedByPort.push(entry.file);
      }
    }
    expect(refusedByPort.sort()).toEqual([
      "invalid/refuse-caller-names-key.json",
      "invalid/refuse-delete-without-erasure.json",
      "invalid/refuse-id-document-for-business.json",
      "invalid/refuse-listing-read-of-id-document.json",
      "invalid/refuse-public-object.json",
      "invalid/refuse-read-without-permission.json",
      "invalid/refuse-svg-upload.json",
    ]);
    // Riley's license photo is still there: the delete for another reason deleted nothing.
    expect(d.double.objects()).toContain(RILEY_LICENSE);
    // The one view is the inline fixture's read, answered as an attachment; no refused read gave a link.
    expect(d.double.views().map((view) => view.fileRow)).toEqual(["docfile-riley-barber-license-photo"]);
  });

  it("names the fields at fault in each refused request, never a value", async () => {
    const d = driven();
    const problemsOf = async (file: string): Promise<readonly string[]> => {
      const fx = exchange(file);
      return (await refusal(askOutcome(d.double, fx.call, fx.request))).problems;
    };
    expect(await problemsOf("invalid/refuse-caller-names-key.json")).toEqual([
      "request.objectKey is not a field of v1",
    ]);
    expect(await problemsOf("invalid/refuse-delete-without-erasure.json")).toEqual([
      "request.reason is not erasure (v1 deletes for erasure only; no deletion rule is invented)",
    ]);
    expect(await problemsOf("invalid/refuse-id-document-for-business.json")).toEqual([
      "request.owner is not a person with no business (an ID document is the person's own)",
    ]);
    expect(await problemsOf("invalid/refuse-listing-read-of-id-document.json")).toEqual([
      "request.objectKey is not a photo's (only a photo is shown on the listing)",
    ]);
    expect(await problemsOf("invalid/refuse-svg-upload.json")).toEqual([
      "request.mediaType is not a photo or PDF type",
    ]);
    const rejected = d.double.rejectedRequests();
    expect(rejected.map((entry) => entry.call)).toEqual([
      "uploadLink",
      "deleteObject",
      "uploadLink",
      "readLink",
      "uploadLink",
    ]);
    const written = JSON.stringify(rejected.map((entry) => entry.problems));
    for (const value of [
      "samleeidphotofrontpage001",
      "replaced",
      "biz-lees-barbershop",
      "q7m2k9x4t8v1c6b3n5p0r2s4w6",
      "svg",
    ])
      expect(written).not.toContain(value);
  });

  it("answers refuse-upload-too-large-ready.json's request tooLarge and refuse-read-link-inline.json's as an attachment", async () => {
    const d = driven();
    const tooLarge = exchange("invalid/refuse-upload-too-large-ready.json");
    d.at(tooLarge.given.now);
    expect(await d.double.uploadLink(tooLarge.request)).toEqual(exchange("upload-too-large.json").outcome);
    await uploaded(d, {
      kind: "licenseFile",
      owner: RILEY_AT_LEES,
      mediaType: "image/jpeg",
      sizeBytes: 900_000,
      id: RILEY_LICENSE.slice(-26),
      at: "2026-10-19T16:00:00Z",
    });
    const inline = exchange("invalid/refuse-read-link-inline.json");
    d.at(inline.given.now);
    const link = await d.double.readLink(inline.request);
    expect(link).toMatchObject({
      result: "link",
      disposition: "attachment",
      noSniff: true,
      expiresAt: "2026-10-20T15:07:00Z",
    });
    if (!("url" in link)) throw new Error("no link was given");
    expect(d.double.get(link.url)).toMatchObject({
      headers: {
        "Content-Disposition": "attachment",
        "X-Content-Type-Options": "nosniff",
        "Content-Type": "image/jpeg",
      },
    });
  });

  it("refuse-key-in-span.json is refused, and the double's span of the same read holds no key: it is span-read-link-logged.json", async () => {
    const refused = readJson(FIXTURES, "invalid/refuse-key-in-span.json");
    expect(validator("filesSpan")(refused)).toBe(false);
    const fx = readJson(FIXTURES, "span-read-link-logged.json") as SpanFixture & Record<string, unknown>;
    const d = driven();
    await uploaded(d, {
      kind: "licenseFile",
      owner: RILEY_AT_LEES,
      mediaType: "image/jpeg",
      sizeBytes: 900_000,
      id: RILEY_LICENSE.slice(-26),
      at: "2026-10-19T16:00:00Z",
    });
    d.at(fx.at);
    await d.double.readLink(exchange("read-link-logged.json").request, callOf(fx));
    const span = d.double.spans().at(-1);
    if (span === undefined) throw new Error("no span was written");
    expectSpan(span);
    expect(span).toEqual({ ...fx, ms: 0, event_id: null });
    expect(JSON.stringify(span)).not.toContain(RILEY_LICENSE.slice(-26));
  });
});

function callOf(fx: SpanFixture): FilesCall {
  const trace: FilesTrace = {
    traceId: fx.trace_id,
    spanId: fx.span_id,
    seq: fx.seq,
    bundleId: fx.bundle_id,
    turnId: fx.turn_id,
    jobId: fx.job_id,
    handleRef: fx.handle_ref,
    businessId: fx.business_id,
  };
  return fx.got.step === undefined
    ? { trace, attempt: fx.attempt }
    : { trace, step: fx.got.step, attempt: fx.attempt };
}

describe("the call's span (K-08 v1 portCall; K-13 v1 filesSpan)", () => {
  it("rebuilds span-upload-link.json from S1-10's upload link for Sam's ID document", async () => {
    const fx = readJson(FIXTURES, "span-upload-link.json") as SpanFixture & Record<string, unknown>;
    const d = driven(fx.at);
    await d.double.uploadLink(exchange("upload-id-document.json").request, callOf(fx));
    const span = only(d.double.spans());
    expectSpan(span);
    // The double answers at once and names no inbound event; everything else is the fixture's.
    expect(span).toEqual({ ...fx, ms: 0, event_id: null });
  });

  it("rebuilds span-delete-erasure.json from the erasure job's delete of Riley's license photo", async () => {
    const fx = readJson(FIXTURES, "span-delete-erasure.json") as SpanFixture & Record<string, unknown>;
    const d = driven();
    await uploaded(d, {
      kind: "licenseFile",
      owner: RILEY_AT_LEES,
      mediaType: "image/jpeg",
      sizeBytes: 900_000,
      id: RILEY_LICENSE.slice(-26),
      at: "2026-10-19T16:00:00Z",
    });
    d.at(fx.at);
    await d.double.deleteObject(exchange("delete-erasure.json").request, callOf(fx));
    const span = d.double.spans().at(-1);
    if (span === undefined) throw new Error("no span was written");
    expectSpan(span);
    expect(span).toEqual({ ...fx, ms: 0, event_id: null });
  });

  it("writes one span per call that filesSpan accepts, and no span or log line holds a key, a link, a hash or a byte", async () => {
    const d = driven();
    const call: FilesCall = { step: "S1-10" };
    await uploaded(d, {
      kind: "idDocument",
      owner: SAM,
      mediaType: "image/heic",
      sizeBytes: 2_000_000,
      at: "2026-10-19T14:30:30Z",
    });
    const linq = await writeOf("server-write-linq-photo.json");
    await d.double.serverWrite(linq.request, linq.body, call);
    await d.double.serverWrite(linq.request, linq.body, call);
    await d.double.serverWrite(
      { ...linq.request, sha256: await sha256Hex(bodyOf(linq.request.sizeBytes, 2)) },
      bodyOf(linq.request.sizeBytes, 2),
      call,
    );
    await d.double.serverRead({ objectKey: "photo/2026-10-19/l4q9p2r7c6e1s8u3n0k5m2v9x3", file: null }, call);
    await d.double.serverRead({ objectKey: "photo/2026-10-19/l4q9p2r7c6e1s8u3n0k5m2v9x4", file: null }, call);
    d.double.failNext({ timedOut: true });
    await d.double.deleteObject(exchange("delete-erasure.json").request, call);
    await d.double.deleteObject(exchange("delete-erasure.json").request, call);
    const spans = d.double.spans();
    expect(spans.map((span) => [span.call, span.outcome, span.error_code, span.decided ?? null])).toEqual([
      ["uploadLink", "ok", null, { result: "ready" }],
      ["checkUpload", "ok", null, { result: "stored", sizeBytes: 2_000_000 }],
      ["serverWrite", "ok", null, { result: "stored", repeated: false }],
      ["serverWrite", "ok", null, { result: "stored", repeated: true }],
      ["serverWrite", "refused", "conflict", null],
      ["serverRead", "ok", null, { result: "read", sizeBytes: 1_650_000 }],
      ["serverRead", "refused", "notFound", null],
      ["deleteObject", "timedOut", "unavailable", null],
      ["deleteObject", "ok", null, { result: "deleted", alreadyGone: true }],
    ]);
    for (const span of spans) {
      expectSpan(span);
      expect(span.provider).toBe("r2");
      expect(span.hop).toBe("portCall");
    }
    expect(spans[2]?.got).toEqual({
      step: "S1-10",
      kind: "photo",
      owner: "business",
      mediaType: "image/jpeg",
      sizeBytes: 1_650_000,
      source: "linq",
    });
    const written = spans.map((span) => spanLogLine(span, LOG)).join("\n");
    for (const secret of [
      ...secretsOfFixtures(),
      linq.request.sha256,
      ...d.double.objects().map((key) => key.slice(-26)),
    ])
      expect(written).not.toContain(secret);
    expect(written).not.toContain("https://");
  });

  it("puts a span given no trace on the double's own: numbered in call order, bundle v0's id, no step", async () => {
    const d = driven();
    await d.double.checkUpload(exchange("check-upload-not-stored.json").request);
    await d.double.readLink(exchange("read-link-not-found.json").request);
    const bundle = (
      readJson(CONTRACTS, "bundle", "fixtures", "bundle-v0-skeleton.json") as {
        manifest: { bundleId: unknown };
      }
    ).manifest.bundleId;
    expect(FILES_DOUBLE_TRACE.bundleId).toEqual(bundle);
    const spans = d.double.spans();
    expect(spans.map((span) => [span.trace_id, span.span_id, span.seq, span.call])).toEqual([
      [FILES_DOUBLE_TRACE.traceId, "span-files-double-0001", 1, "checkUpload"],
      [FILES_DOUBLE_TRACE.traceId, "span-files-double-0002", 2, "readLink"],
    ]);
    for (const span of spans) {
      expectSpan(span);
      expect(span).toMatchObject({ bundle_id: bundle, turn_id: null, handle_ref: null, attempt: 1 });
      expect(Object.keys(span.got ?? {})).not.toContain("step");
    }
  });

  it("refuses a call its span cannot be written for, and leaves nothing behind", async () => {
    const d = driven();
    d.double.failNext();
    const linq = await writeOf("server-write-linq-photo.json");
    await expect(d.double.serverWrite(linq.request, linq.body, { attempt: 0 })).rejects.toThrow(/attempt/);
    await expect(
      d.double.uploadLink(exchange("upload-id-document.json").request, { attempt: 1.5 }),
    ).rejects.toThrow(/attempt/);
    await expect(
      createFilesDouble({ now: () => "not a time" }).serverRead({ objectKey: LEES_FRONT, file: null }),
    ).rejects.toThrow(TypeError);
    expect(d.double.objects()).toEqual([]);
    expect(d.double.spans()).toEqual([]);
    expect(d.double.requests()).toEqual([]);
    // The error the test set still waits for the next call the double takes.
    expect(await d.double.serverWrite(linq.request, linq.body)).toEqual({ error: "unavailable" });
  });
});

describe("signed uploads (uploadLink, the browser's PUT, checkUpload)", () => {
  const ask = (kind: UploadKind, mediaType: UploadMediaType, sizeBytes: number): UploadLinkRequest => ({
    kind,
    owner: kind === "idDocument" ? SAM : LEES,
    mediaType,
    sizeBytes,
    visibility: "private",
    lifeSeconds: 900,
  });

  it("takes the image types for a photo and a photo or a PDF for every other kind; the type is checked before the size", async () => {
    const d = driven();
    for (const kind of UPLOAD_KINDS)
      for (const mediaType of UPLOAD_MEDIA_TYPES) {
        const outcome = await d.double.uploadLink(ask(kind, mediaType, 1000));
        if (kind === "photo" && mediaType === "application/pdf")
          expect(outcome).toEqual({ error: "wrongType", allowed: [...IMAGE_TYPES] });
        else
          expect(outcome, `${kind} ${mediaType}`).toMatchObject({
            result: "ready",
            contentType: mediaType,
            method: "PUT",
          });
        expectExchange("uploadLink", ask(kind, mediaType, 1000), outcome);
      }
    expect(await d.double.uploadLink(ask("photo", "application/pdf", 12_000_000))).toMatchObject({
      error: "wrongType",
    });
    expect(await d.double.uploadLink(ask("form", "application/pdf", UPLOAD_MAX_BYTES))).toMatchObject({
      result: "ready",
      maxBytes: UPLOAD_MAX_BYTES,
    });
    expect(await d.double.uploadLink(ask("form", "application/pdf", UPLOAD_MAX_BYTES + 1))).toEqual({
      error: "tooLarge",
      maxBytes: UPLOAD_MAX_BYTES,
    });
  });

  it("makes every key itself, `<kind>/<the UTC day>/<26 random letters and digits>`, never the same twice, never in the link", async () => {
    const double = createFilesDouble({ now: () => "2026-10-19T23:59:59.500Z" });
    const keys = new Set<string>();
    for (let n = 0; n < 50; n += 1) {
      const ready = readyOf(await double.uploadLink(ask("priceList", "image/jpeg", 1000)));
      expect(ready.objectKey).toMatch(/^priceList\/2026-10-19\/[a-z0-9]{26}$/);
      expect(ready.url).toMatch(/^https:\/\/files\.example\/upload\/[a-z0-9]{26}$/);
      expect(ready.url).not.toContain(ready.objectKey.slice(-26));
      keys.add(ready.objectKey);
    }
    expect(keys.size).toBe(50);
    // The id source must give the key's form; a key already made is never made again.
    const fixed = createFilesDouble({
      newId: () => "q7m2k9x4t8v1c6b3n5p0r2s4w6",
      now: () => "2026-10-19T14:30:30Z",
    });
    await fixed.uploadLink(ask("idDocument", "image/jpeg", 1000));
    await expect(fixed.uploadLink(ask("idDocument", "image/jpeg", 1000))).rejects.toThrow(/already in use/);
    await expect(
      createFilesDouble({ newId: () => "Sam-Lee" }).uploadLink(ask("photo", "image/png", 9)),
    ).rejects.toThrow(/newId/);
    await expect(
      createFilesDouble({
        newId: () => "q7m2k9x4t8v1c6b3n5p0r2s4w6",
        linkUrl: () => "https://files.example/q7m2k9x4t8v1c6b3n5p0r2s4w6",
      }).uploadLink(ask("photo", "image/png", 9)),
    ).rejects.toThrow(/holds the object key/);
    await expect(
      createFilesDouble({ linkUrl: () => "http://files.example/upload/1" }).uploadLink(
        ask("photo", "image/png", 9),
      ),
    ).rejects.toThrow(/https/);
  });

  it("takes one PUT of the type asked within the limit until the link's end; refuses every other", async () => {
    const d = driven();
    const ready = readyOf(await d.double.uploadLink(ask("idDocument", "image/jpeg", 2_400_000)));
    const jpeg = fileOf("image/jpeg", 2_400_000);
    expect(await d.double.put(ready.url, jpeg, "image/png")).toEqual({
      result: "refused",
      status: 415,
      reason: "wrongContentType",
    });
    expect(await d.double.put(ready.url, fileOf("image/jpeg", UPLOAD_MAX_BYTES + 1), "image/jpeg")).toEqual({
      result: "refused",
      status: 413,
      reason: "tooLarge",
    });
    expect(await d.double.put(`${ready.url}x`, jpeg, "image/jpeg")).toEqual({
      result: "refused",
      status: 403,
      reason: "unknownLink",
    });
    expect(d.double.objects()).toEqual([]);
    expect(await d.double.put(ready.url, jpeg, "image/jpeg")).toEqual({ result: "stored", status: 200 });
    expect(await d.double.put(ready.url, jpeg, "image/jpeg")).toEqual({
      result: "refused",
      status: 409,
      reason: "used",
    });
    // An upload link is no read link, and a read link takes no PUT.
    expect(d.double.get(ready.url)).toEqual({ result: "refused", status: 403, reason: "unknownLink" });
    const link = await d.double.readLink({
      objectKey: ready.objectKey,
      file: { table: "id_uploads", id: "idupload-sam-1" },
      viewer: { as: "self", personId: "person-sam" },
      lifeSeconds: 60,
    });
    if (!("url" in link)) throw new Error("no link was given");
    expect(await d.double.put(link.url, jpeg, "image/jpeg")).toEqual({
      result: "refused",
      status: 403,
      reason: "unknownLink",
    });
    expect(d.double.objectInfo(ready.objectKey)).toEqual({
      objectKey: ready.objectKey,
      kind: "idDocument",
      owner: SAM,
      mediaType: "image/jpeg",
      sizeBytes: 2_400_000,
      visibility: "private",
      storedAt: "2026-10-19T14:00:00Z",
      came: "upload",
    });
  });

  it("reads the type from the leading bytes, takes HEIC and HEIF as one family, and removes a refused file before it answers", async () => {
    const d = driven();
    const cases: [UploadMediaType, number[], "stored" | "wrongType"][] = [
      ["image/heic", SIGNATURES["image/heif"], "stored"],
      ["image/heif", SIGNATURES["image/heic"], "stored"],
      ["image/webp", SIGNATURES["image/webp"], "stored"],
      ["image/png", SIGNATURES["image/jpeg"], "wrongType"],
      // An SVG sent with a PNG's Content-Type: its bytes are no photo.
      ["image/png", [...new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'>")], "wrongType"],
      ["application/pdf", [...new TextEncoder().encode("<html><script>")], "wrongType"],
    ];
    for (const [mediaType, leading, answer] of cases) {
      const ready = readyOf(await d.double.uploadLink(ask("signedDocument", mediaType, 4096)));
      const bytes = new Uint8Array(4096);
      bytes.set(leading);
      await d.double.put(ready.url, bytes, mediaType);
      const checked = await d.double.checkUpload({
        objectKey: ready.objectKey,
        mediaType,
        maxBytes: UPLOAD_MAX_BYTES,
      });
      expectExchange(
        "checkUpload",
        { objectKey: ready.objectKey, mediaType, maxBytes: UPLOAD_MAX_BYTES },
        checked,
      );
      if (answer === "stored") {
        expect(checked).toEqual({
          result: "stored",
          sizeBytes: 4096,
          mediaType,
          storedAt: "2026-10-19T14:00:00Z",
        });
        expect(d.double.objects()).toContain(ready.objectKey);
      } else {
        expect(checked).toEqual({ error: "wrongType", allowed: [mediaType], removed: true });
        expect(d.double.objects()).not.toContain(ready.objectKey);
        // Gone: a second check finds nothing, and no read link can be given for it.
        expect(
          await d.double.checkUpload({ objectKey: ready.objectKey, mediaType, maxBytes: UPLOAD_MAX_BYTES }),
        ).toEqual({ result: "notStored" });
      }
    }
  });

  it("refuses and removes a stored file over 10 MiB under an upload kind's key, whatever wrote it", async () => {
    const d = driven();
    // The browser's PUT can never store more than the limit, so the only way such a file sits under an upload key is
    // another writer's: a photo by text of 10 MiB and a byte, which the page entry then wrongly checks as an upload.
    const body = fileOf("image/jpeg", UPLOAD_MAX_BYTES + 1);
    const writeId = newKeyId();
    const written = await d.double.serverWrite(
      {
        kind: "photo",
        owner: LEES,
        mediaType: "image/jpeg",
        sizeBytes: body.byteLength,
        sha256: await sha256Hex(body),
        writeId,
        day: "2026-10-19",
        visibility: "private",
        source: { kind: "linq", eventId: "evt-sam-0004", attachmentId: "att-sam-price-list" },
      },
      body,
    );
    if (!("objectKey" in written)) throw new Error("the photo was not written");
    const request = {
      objectKey: written.objectKey,
      mediaType: "image/jpeg",
      maxBytes: UPLOAD_MAX_BYTES,
    } as const;
    const checked = await d.double.checkUpload(request);
    expect(checked).toEqual({
      error: "tooLarge",
      maxBytes: UPLOAD_MAX_BYTES,
      sizeBytes: UPLOAD_MAX_BYTES + 1,
      removed: true,
    });
    expectExchange("checkUpload", request, checked);
    expect(d.double.objects()).toEqual([]);
  });
});

describe("server writes, server reads and the delete", () => {
  it("never writes over other bytes under a writeId: conflict, and the first bytes stay", async () => {
    const d = driven();
    const first = await writeOf("server-write-done-photo.json", 1);
    const other = await writeOf("server-write-done-photo.json", 2);
    expect(await d.double.serverWrite(first.request, first.body)).toMatchObject({
      result: "stored",
      repeated: false,
    });
    expect(await d.double.serverWrite(other.request, other.body)).toEqual({ error: "conflict" });
    const read = await d.double.serverRead({
      objectKey: "photo/2026-10-22/d0n3p6h9t2o5j8r1x4a7c0e3g6",
      file: { table: "visit_marks", id: "visit-alex-drain-1" },
    });
    expect(read.bytes).toEqual(first.body);
    expect(read.outcome).toEqual({ result: "read", mediaType: "image/jpeg", sizeBytes: 2_100_000 });
  });

  it("refuses a body that is not the request's bytes, before any call: no span, nothing stored", async () => {
    const d = driven();
    const { request, body } = await writeOf("server-write-sealed-trace.json");
    const placeholder = exchange("server-write-sealed-trace.json").request;
    expect((await refusal(d.double.serverWrite(placeholder, body))).problems).toEqual([
      "body's sha256 is not request.sha256",
    ]);
    expect((await refusal(d.double.serverWrite(request, body.subarray(1)))).problems).toEqual([
      "body is not request.sizeBytes long",
    ]);
    expect((await refusal(d.double.serverWrite(request, "bytes" as unknown as Uint8Array))).problems).toEqual(
      ["body is not bytes"],
    );
    expect(d.double.spans()).toEqual([]);
    expect(d.double.objects()).toEqual([]);
    // The bytes checked are the bytes kept: changing the caller's array after the call changes nothing stored.
    const copy = body.slice();
    await d.double.serverWrite(request, copy);
    copy[0] = 9;
    expect(
      (
        await d.double.serverRead({
          objectKey: "sealedTrace/2026-10-19/t5r8c3s6q1w9e4a7d2f0g6h3j8",
          file: null,
        })
      ).bytes,
    ).toEqual(body);
  });

  it("refuses each write kind's wrong type, owner or source, and a photo is the only kind that comes in by text", async () => {
    const d = driven();
    const { request, body } = await writeOf("server-write-sealed-trace.json");
    const wrong: [Partial<ServerWriteRequest>, string][] = [
      [{ mediaType: "image/jpeg" }, "request.mediaType is not a type this write kind takes"],
      [{ owner: LEES }, "request.owner.kind is not rosie"],
      [
        { source: { kind: "linq", eventId: "evt-sam-0004", attachmentId: "att-sam-price-list" } },
        "request.source.kind is not one this write kind takes (only a photo comes in by text)",
      ],
      [
        { kind: "export", mediaType: "text/csv", owner: { kind: "rosie" } },
        "request.owner.kind is not business",
      ],
      [
        { kind: "report", mediaType: "text/csv", owner: ALEX_HEATER },
        "request.mediaType is not a type this write kind takes",
      ],
      [
        { kind: "photo", mediaType: "image/jpeg", owner: { kind: "rosie" } },
        "request.owner.kind is not person, business, booking",
      ],
      [{ writeId: "trace-sam-0009" }, "request.writeId is not 26 lowercase letters and digits"],
      [{ day: "2026-02-30" }, "request.day is not a calendar day"],
      [{ visibility: "public" as "private" }, "request.visibility is not private (every object is private)"],
    ];
    for (const [change, problem] of wrong) {
      const refused = await refusal(d.double.serverWrite({ ...request, ...change }, body));
      expect(refused.problems, problem).toContain(problem);
    }
    expect(d.double.spans()).toEqual([]);
    expect(d.double.objects()).toEqual([]);
  });

  it("deletes for erasure only, leaves nothing behind, and no upload link lands a file after it", async () => {
    const d = driven();
    const key = await uploaded(d, {
      kind: "licenseFile",
      owner: RILEY_AT_LEES,
      mediaType: "image/jpeg",
      sizeBytes: 900_000,
      at: "2026-10-19T16:00:00Z",
    });
    const pending = readyOf(
      await d.double.uploadLink({
        kind: "licenseFile",
        owner: RILEY_AT_LEES,
        mediaType: "application/pdf",
        sizeBytes: 30_000,
        visibility: "private",
        lifeSeconds: 1800,
      }),
    );
    const link = await d.double.readLink({
      objectKey: key,
      file: { table: "document_files", id: "docfile-riley-barber-license-photo" },
      viewer: { as: "business", personId: "person-sam" },
      lifeSeconds: 900,
    });
    if (!("url" in link)) throw new Error("no link was given");
    const erase = (objectKey: string) => ({
      objectKey,
      file: { table: "document_files", id: "docfile-riley-barber-license-photo" },
      reason: "erasure" as const,
      erasure: { personId: "person-riley", checkedAt: "2026-10-26T15:00:00Z" },
    });
    expect(await d.double.deleteObject(erase(key))).toEqual({ result: "deleted", alreadyGone: false });
    expect(await d.double.deleteObject(erase(pending.objectKey))).toEqual({
      result: "deleted",
      alreadyGone: true,
    });
    expect(d.double.objects()).toEqual([]);
    expect(d.double.get(link.url)).toEqual({ result: "refused", status: 404, reason: "notFound" });
    expect(await d.double.put(pending.url, fileOf("application/pdf", 30_000), "application/pdf")).toEqual({
      result: "refused",
      status: 409,
      reason: "used",
    });
    expect(d.double.objects()).toEqual([]);
    await refusal(
      d.double.deleteObject({
        ...erase(key),
        erasure: { personId: "person-riley", checkedAt: "2026-10-26" },
      }),
    );
    await refusal(d.double.deleteObject({ ...erase(key), file: null }));
  });
});

describe("errors the test sets (K-13 v1 README 'An error')", () => {
  it("answers the next call unavailable with its span, changes nothing, and answers the call after as before", async () => {
    const d = driven();
    const key = await uploaded(d, {
      kind: "licenseFile",
      owner: RILEY_AT_LEES,
      mediaType: "image/jpeg",
      sizeBytes: 900_000,
      at: "2026-10-19T16:00:00Z",
    });
    const linq = await writeOf("server-write-linq-photo.json");
    const erase = {
      objectKey: key,
      file: { table: "document_files", id: "docfile-riley" },
      reason: "erasure",
      erasure: { personId: "person-riley", checkedAt: "2026-10-26T15:00:00Z" },
    } as const;
    const read: ReadLinkRequest = {
      objectKey: key,
      file: { table: "document_files", id: "docfile-riley" },
      viewer: { as: "self", personId: "person-riley" },
      lifeSeconds: 60,
    };
    const spansBefore = d.double.spans().length;

    d.double.failNext({ times: 6 });
    expect(await d.double.uploadLink(exchange("upload-id-document.json").request)).toEqual({
      error: "unavailable",
    });
    expect(
      await d.double.checkUpload({ objectKey: key, mediaType: "image/png", maxBytes: UPLOAD_MAX_BYTES }),
    ).toEqual({ error: "unavailable" });
    expect(await d.double.readLink(read)).toEqual({ error: "unavailable" });
    expect(await d.double.serverWrite(linq.request, linq.body)).toEqual({ error: "unavailable" });
    expect(await d.double.serverRead({ objectKey: key, file: null })).toEqual({
      outcome: { error: "unavailable" },
      bytes: null,
    });
    expect(await d.double.deleteObject(erase)).toEqual({ error: "unavailable" });
    // Nothing changed: the license photo is still there (a wrong-type check did not remove it), nothing was written.
    expect(d.double.objects()).toEqual([key]);
    expect(d.double.views()).toEqual([]);
    const failed = d.double.spans().slice(spansBefore);
    expect(failed.map((span) => [span.call, span.outcome, span.error_code, "decided" in span])).toEqual(
      (["uploadLink", "checkUpload", "readLink", "serverWrite", "serverRead", "deleteObject"] as const).map(
        (call) => [call, "failed", "unavailable", false],
      ),
    );
    for (const span of failed) expectSpan(span);
    expect(await d.double.serverWrite(linq.request, linq.body)).toMatchObject({
      result: "stored",
      repeated: false,
    });
  });

  it("refuses a times that is no whole number of 1 or more, and leaves an error set for the next call the double takes", async () => {
    const d = driven();
    expect(() => {
      d.double.failNext({ times: 0 });
    }).toThrow(/times/);
    d.double.failNext();
    await refusal(d.double.uploadLink({ kind: "photo" }));
    expect(await d.double.checkUpload(exchange("check-upload-not-stored.json").request)).toEqual({
      error: "unavailable",
    });
    expect(await d.double.checkUpload(exchange("check-upload-not-stored.json").request)).toEqual({
      result: "notStored",
    });
  });
});

describe("the port's callers", () => {
  it("is K-13's FilesPort: the page entry's upload and check, C-094's read link, the erasure job's delete", async () => {
    let now = "2026-10-19T14:30:30Z";
    const port: FilesPort = createFilesDouble({ now: () => now });
    const double = port as FilesDouble;
    const ready = readyOf(
      await port.uploadLink(exchange("upload-id-document.json").request as unknown as UploadLinkRequest),
    );
    now = "2026-10-19T14:30:41Z";
    await double.put(ready.url, fileOf("image/jpeg", 2_400_000), "image/jpeg");
    now = "2026-10-19T14:31:00Z";
    expect(
      await port.checkUpload({
        objectKey: ready.objectKey,
        mediaType: "image/jpeg",
        maxBytes: UPLOAD_MAX_BYTES,
      }),
    ).toEqual({
      result: "stored",
      sizeBytes: 2_400_000,
      mediaType: "image/jpeg",
      storedAt: "2026-10-19T14:30:41Z",
    });
    const link = await port.readLink({
      objectKey: ready.objectKey,
      file: { table: "id_uploads", id: "idupload-sam-1" },
      viewer: { as: "self", personId: "person-sam" },
      lifeSeconds: 300,
    });
    expect(link).toMatchObject({ result: "link", expiresAt: "2026-10-19T14:36:00Z" });
    expect(
      await port.deleteObject({
        objectKey: ready.objectKey,
        file: { table: "id_uploads", id: "idupload-sam-1" },
        reason: "erasure",
        erasure: { personId: "person-sam", checkedAt: "2026-10-19T14:20:00Z" },
      }),
    ).toEqual({
      result: "deleted",
      alreadyGone: false,
    });
    expect(double.objects()).toEqual([]);
  });

  it("gives copies: changing an answer, a record or served bytes changes nothing the double holds", async () => {
    const d = driven();
    const linq = await writeOf("server-write-linq-photo.json");
    await d.double.serverWrite(linq.request, linq.body);
    const read = await d.double.serverRead({
      objectKey: "photo/2026-10-19/l4q9p2r7c6e1s8u3n0k5m2v9x3",
      file: null,
    });
    read.bytes?.fill(7);
    const records = d.double.requests();
    Object.assign(records[0]?.request ?? {}, { kind: "report" });
    const again = await d.double.serverRead({
      objectKey: "photo/2026-10-19/l4q9p2r7c6e1s8u3n0k5m2v9x3",
      file: null,
    });
    expect(again.bytes).toEqual(linq.body);
    expect(d.double.requests()[0]).toEqual({ call: "serverWrite", request: linq.request });
  });

  it("records each request it took with its call, in order, and reset clears every object, link, record and error set", async () => {
    const d = driven();
    const key = await uploaded(d, {
      kind: "photo",
      owner: LEES,
      mediaType: "image/webp",
      sizeBytes: 5000,
      at: "2026-10-19T15:00:00Z",
    });
    await refusal(d.double.readLink({ objectKey: key }));
    d.double.failNext();
    expect(d.double.requests().map((record) => record.call)).toEqual(["uploadLink", "checkUpload"]);
    expect(d.double.rejectedRequests()).toHaveLength(1);
    d.double.reset();
    expect(d.double.objects()).toEqual([]);
    expect(d.double.requests()).toEqual([]);
    expect(d.double.rejectedRequests()).toEqual([]);
    expect(d.double.spans()).toEqual([]);
    expect(
      await d.double.checkUpload({ objectKey: key, mediaType: "image/webp", maxBytes: UPLOAD_MAX_BYTES }),
    ).toEqual({ result: "notStored" });
    expect(only(d.double.spans()).seq).toBe(1);
  });
});
