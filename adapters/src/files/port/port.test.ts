// T-437: the files port's own parts (keys, the leading-bytes check, the refused requests, the rules and the span),
// against K-13 v1's schema and fixtures (contracts/port-files). The double's tests (../double/double.test.ts) drive the
// calls; these pin what the R2 adapter (T-438) takes from here unchanged. Ids are the fixtures' (rule 9).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";

import { buildOutsideCallSpan } from "../../shared/spans";
import {
  buildFilesSpan,
  bytesShowType,
  checkCheckUploadRequest,
  checkDeleteObjectRequest,
  checkReadLinkRequest,
  checkServerReadRequest,
  checkServerWriteRequest,
  checkUploadLinkRequest,
  dayOf,
  endedOf,
  FILE_KINDS,
  isDay,
  isUtc,
  linkExpiresAt,
  linkIsLive,
  newKeyId,
  objectKeyOf,
  parseObjectKey,
  sha256Hex,
  sniffMediaType,
  storedFileRefusal,
  UPLOAD_KINDS,
  UPLOAD_MAX_BYTES,
  uploadLinkRefusal,
  uploadTypesFor,
  utcSeconds,
  viewRecordOf,
  WRITE_KINDS,
  WRITE_RULES,
  writeBodyProblems,
  writeObjectKey,
  type Checked,
  type FilesCallName,
  type FilesTrace,
  type ServerWriteRequest,
  type UploadLinkOutcome,
} from ".";

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

interface IndexEntry {
  file: string;
  version: string;
  def: string;
  expect: "accept" | "refuse";
}

interface Exchange {
  call: FilesCallName;
  request: Record<string, unknown>;
  outcome: Record<string, unknown>;
}

const readJson = (...parts: string[]): unknown =>
  JSON.parse(readFileSync(path.join(...parts), "utf8")) as unknown;
const INDEX = (readJson(FIXTURES, "index.json") as { fixtures: IndexEntry[] }).fixtures;
const exchange = (file: string): Exchange => readJson(FIXTURES, file) as Exchange;

const CHECKS: Record<FilesCallName, (request: unknown) => Checked<unknown>> = {
  uploadLink: checkUploadLinkRequest,
  checkUpload: checkCheckUploadRequest,
  readLink: checkReadLinkRequest,
  serverWrite: checkServerWriteRequest,
  serverRead: checkServerReadRequest,
  deleteObject: checkDeleteObjectRequest,
};

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

const TRACE: FilesTrace = {
  traceId: "trace-page-sam-0006",
  spanId: "span-page-sam-0006-02",
  seq: 2,
  bundleId: { hash: "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037", build: 1 },
  turnId: null,
  jobId: "req-secure-sam-0006-upload",
  handleRef: null,
};

describe("object keys (K-13 v1 README 'The object key')", () => {
  it("makes ids of 26 lowercase letters and digits from a secure source, every symbol in use, none twice", () => {
    const ids = Array.from({ length: 400 }, () => newKeyId());
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{26}$/);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids.join("")).size).toBe(36);
    // 26 symbols of 36 hold at least the 128 bits the README asks.
    expect(26 * Math.log2(36)).toBeGreaterThanOrEqual(128);
  });

  it("builds and reads `<kind>/<day>/<id>` for every file kind on calendar days only", () => {
    for (const kind of FILE_KINDS) {
      const key = objectKeyOf(kind, "2028-02-29", "q7m2k9x4t8v1c6b3n5p0r2s4w6");
      expect(validator("objectKey")(key)).toBe(true);
      expect(parseObjectKey(key)).toEqual({ kind, day: "2028-02-29", id: "q7m2k9x4t8v1c6b3n5p0r2s4w6" });
    }
    // The schema's pattern takes Feb 30; the port's code check does not.
    expect(validator("objectKey")("photo/2026-02-30/q7m2k9x4t8v1c6b3n5p0r2s4w6")).toBe(true);
    for (const bad of [
      "photo/2026-02-30/q7m2k9x4t8v1c6b3n5p0r2s4w6",
      "photo/2027-02-29/q7m2k9x4t8v1c6b3n5p0r2s4w6",
      "photos/2026-10-19/q7m2k9x4t8v1c6b3n5p0r2s4w6",
      "photo/2026-10-19/Q7m2k9x4t8v1c6b3n5p0r2s4w6",
      "photo/2026-10-19/q7m2k9x4t8v1c6b3n5p0r2s4w",
      "photos/biz-lees-barbershop/shop-front.jpg",
      "idDocument/2026-10-19/samleeidphotofrontpage001",
      "photo/2026-10-19/q7m2k9x4t8v1c6b3n5p0r2s4w6/x",
      42,
    ])
      expect(parseObjectKey(bad), String(bad)).toBeNull();
    expect(() => objectKeyOf("photo", "2026-02-30", newKeyId())).toThrow(/calendar day/);
    expect(() => objectKeyOf("photo", "2026-10-19", "Sam-Lee")).toThrow(/26 lowercase/);
    expect(() => objectKeyOf("photos" as "photo", "2026-10-19", newKeyId())).toThrow(/file kind/);
    expect(
      writeObjectKey({ kind: "eventLogExport", day: "2026-10-19", writeId: "p2q7e4x9l1o6g3r8c5u0n2t7s4" }),
    ).toBe("eventLogExport/2026-10-19/p2q7e4x9l1o6g3r8c5u0n2t7s4");
  });

  it("checks days and UTC times as the schema leaves to code, and writes times in whole seconds", () => {
    for (const day of ["2026-10-19", "2028-02-29", "2026-12-31"]) expect(isDay(day), day).toBe(true);
    for (const day of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-1-19", "19-10-2026", 20261019])
      expect(isDay(day), String(day)).toBe(false);
    for (const at of ["2026-10-26T15:00:00Z", "2026-10-26T15:00:00.120Z"]) expect(isUtc(at), at).toBe(true);
    for (const at of ["2026-10-26T24:00:00Z", "2026-02-30T15:00:00Z", "2026-10-26T15:00:00", "2026-10-26"])
      expect(isUtc(at), at).toBe(false);
    expect(dayOf(new Date("2026-10-19T23:59:59.999Z"))).toBe("2026-10-19");
    expect(utcSeconds(new Date("2026-10-19T14:30:30.110Z"))).toBe("2026-10-19T14:30:30Z");
  });

  it("hashes bytes as sha256 in lowercase hex", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("the leading-bytes check (README 'What checkUpload reads', default 8)", () => {
  const bytes = (...values: (number | string)[]): Uint8Array =>
    new Uint8Array(
      values.flatMap((value) => (typeof value === "string" ? [...new TextEncoder().encode(value)] : [value])),
    );
  const ftyp = (major: string, ...compatible: string[]): Uint8Array =>
    bytes(0, 0, 0, 16 + compatible.length * 4, "ftyp", major, 0, 0, 0, 0, ...compatible);

  it("reads JPEG, PNG, WebP, PDF, HEIC and HEIF from their signatures", () => {
    expect(sniffMediaType(bytes(0xff, 0xd8, 0xff, 0xdb))).toBe("image/jpeg");
    expect(sniffMediaType(bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffMediaType(bytes("RIFF", 1, 2, 3, 4, "WEBP", "VP8 "))).toBe("image/webp");
    expect(sniffMediaType(bytes("%PDF-1.4"))).toBe("application/pdf");
    expect(sniffMediaType(ftyp("heic", "mif1", "heic"))).toBe("image/heic");
    expect(sniffMediaType(ftyp("mif1", "mif1", "heic"))).toBe("image/heic");
    expect(sniffMediaType(ftyp("mif1", "mif1"))).toBe("image/heif");
    expect(sniffMediaType(ftyp("msf1", "msf1", "hevc"))).toBe("image/heic");
  });

  it("finds no type K-13 takes in an SVG, a page, an AVIF, a video, a RIFF that is no WebP, or too few bytes", () => {
    const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
    for (const leading of [
      enc("<svg xmlns='http://www.w3.org/2000/svg'><script>"),
      enc("<?xml version='1.0'?><svg>"),
      enc("<!DOCTYPE html><html>"),
      enc("<html xmlns='http://www.w3.org/1999/xhtml'>"),
      ftyp("avif", "mif1", "avif"),
      ftyp("isom", "isom", "mp41"),
      ftyp("qt  ", "qt  "),
      bytes("RIFF", 1, 2, 3, 4, "WAVE"),
      bytes(0xff, 0xd8),
      bytes(0, 0, 0, 8, "ftyp"),
      new Uint8Array(64),
      new Uint8Array(0),
    ])
      expect(sniffMediaType(leading)).toBeNull();
  });

  it("takes HEIC and HEIF as one family, and every other type only as itself", () => {
    expect(bytesShowType(ftyp("mif1", "mif1", "heic"), "image/heif")).toBe(true);
    expect(bytesShowType(ftyp("mif1", "mif1"), "image/heic")).toBe(true);
    expect(bytesShowType(bytes(0xff, 0xd8, 0xff), "image/png")).toBe(false);
    expect(bytesShowType(bytes("%PDF-"), "image/jpeg")).toBe(false);
    expect(bytesShowType(bytes(0xff, 0xd8, 0xff), "application/pdf")).toBe(false);
    expect(bytesShowType(ftyp("avif", "mif1"), "image/heif")).toBe(false);
  });
});

describe("the requests the port refuses (K-13 v1's schema and its code checks)", () => {
  it("passes every accepted exchange fixture's request and refuses the request of each refused fixture whose fault is in it", () => {
    for (const entry of INDEX) {
      if (!entry.def.endsWith(".exchange")) continue;
      const fx = exchange(entry.file);
      const checked = CHECKS[fx.call](fx.request);
      const schemaSays = validator(`${fx.call}.request`)(fx.request);
      expect(checked.problems.length === 0, entry.file).toBe(schemaSays);
      if (entry.expect === "accept") {
        expect(checked.problems, entry.file).toEqual([]);
        expect(checked.request, entry.file).toEqual(fx.request);
      }
    }
  });

  it("gives the schema's verdict on each request one change away from a fixture's", () => {
    const changed = (file: string, change: (request: Record<string, unknown>) => void): [string, unknown] => {
      const fx = exchange(file);
      const request = structuredClone(fx.request);
      change(request);
      return [fx.call, request];
    };
    const cases: [string, unknown][] = [
      changed("upload-id-document.json", (r) => (r.visibility = "public")),
      changed("upload-id-document.json", (r) => (r.lifeSeconds = 59)),
      changed("upload-id-document.json", (r) => (r.lifeSeconds = 1800)),
      changed("upload-id-document.json", (r) => (r.lifeSeconds = 1801)),
      changed("upload-id-document.json", (r) => (r.sizeBytes = 0)),
      changed("upload-id-document.json", (r) => (r.sizeBytes = 1.5)),
      changed("upload-id-document.json", (r) => (r.mediaType = "image/gif")),
      changed("upload-id-document.json", (r) => (r.mediaType = "application/xhtml+xml")),
      changed("upload-id-document.json", (r) => (r.owner = { kind: "person", personId: "person-sam" })),
      changed(
        "upload-id-document.json",
        (r) => (r.owner = { kind: "person", personId: "", businessId: null }),
      ),
      changed("upload-id-document.json", (r) => (r.owner = { kind: "rosie" })),
      changed("upload-id-document.json", (r) => (r.kind = "sealedTrace")),
      changed("upload-id-document.json", (r) => (r.url = "https://files.example/upload/x")),
      changed(
        "upload-price-list-photo.json",
        (r) =>
          (r.owner = {
            kind: "booking",
            businessId: "biz-lees-barbershop",
            bookingId: "booking-alex-drain",
            personId: null,
          }),
      ),
      changed(
        "upload-price-list-photo.json",
        (r) => (r.owner = { kind: "business", businessId: "biz-lees-barbershop", personId: "person-sam" }),
      ),
      changed("check-upload-stored.json", (r) => (r.maxBytes = 5_000_000)),
      changed(
        "check-upload-stored.json",
        (r) => (r.objectKey = "sealedTrace/2026-10-19/q7m2k9x4t8v1c6b3n5p0r2s4w6"),
      ),
      changed("check-upload-stored.json", (r) => (r.mediaType = "video/mp4")),
      changed("read-link-logged.json", (r) => (r.lifeSeconds = 901)),
      changed("read-link-logged.json", (r) => (r.lifeSeconds = 60)),
      changed("read-link-logged.json", (r) => (r.viewer = { as: "listing", personId: "person-sam" })),
      changed("read-link-logged.json", (r) => (r.viewer = { as: "self", personId: null })),
      changed("read-link-logged.json", (r) => (r.viewer = { as: "customer", personId: "person-alex" })),
      changed(
        "read-link-logged.json",
        (r) => (r.file = { table: "Document Files", id: "docfile-riley-barber-license-photo" }),
      ),
      changed("read-link-logged.json", (r) => (r.file = { table: "document_files", id: "+15555550177" })),
      changed("read-link-logged.json", (r) => (r.file = null)),
      changed(
        "read-link-listing-photo.json",
        (r) => (r.objectKey = "priceList/2026-10-19/f9r2n7t4s1h6p3o8m5c0k2x7v4"),
      ),
      changed("read-link-listing-photo.json", (r) => (r.viewer = { as: "listing" })),
      changed("server-write-linq-photo.json", (r) => (r.mediaType = "application/pdf")),
      changed("server-write-linq-photo.json", (r) => (r.owner = { kind: "rosie" })),
      changed("server-write-linq-photo.json", (r) => (r.source = { kind: "linq", eventId: "evt-sam-0004" })),
      changed("server-write-linq-photo.json", (r) => (r.source = { kind: "email" })),
      changed(
        "server-write-linq-photo.json",
        (r) => (r.sha256 = "0F9E8D7C6B5A493827160F9E8D7C6B5A493827160F9E8D7C6B5A493827160F9E"),
      ),
      changed("server-write-linq-photo.json", (r) => (r.writeId = "l4q9p2r7c6e1s8u3n0k5m2v9x")),
      changed("server-write-report.json", (r) => (r.mediaType = "video/webm")),
      changed(
        "server-write-report.json",
        (r) => (r.source = { kind: "linq", eventId: "evt-jordan-0074", attachmentId: "att-jordan-report" }),
      ),
      changed(
        "server-write-report.json",
        (r) => (r.owner = { kind: "business", businessId: "biz-lee-home-services" }),
      ),
      changed("server-write-parquet.json", (r) => (r.mediaType = "text/csv")),
      changed(
        "server-write-parquet.json",
        (r) => (r.owner = { kind: "business", businessId: "biz-lees-barbershop" }),
      ),
      changed(
        "server-write-done-photo.json",
        (r) => (r.owner = { kind: "person", personId: "person-jordan", businessId: "biz-lee-home-services" }),
      ),
      changed(
        "server-read-photo.json",
        (r) => (r.file = { table: "business_photos", id: "photo-lees-barbershop-front" }),
      ),
      changed("server-read-photo.json", (r) => (r.file = undefined)),
      changed("delete-erasure.json", (r) => (r.erasure = { personId: "person-riley" })),
      changed("delete-erasure.json", (r) => (r.reason = "expired")),
      changed("delete-erasure.json", (r) => delete r.reason),
    ];
    for (const [call, request] of cases) {
      const schemaSays = validator(`${call}.request`)(request);
      const checked = CHECKS[call as FilesCallName](request);
      expect(checked.problems.length === 0, JSON.stringify(request)).toBe(schemaSays);
    }
    // Most of them are refusals: the cross-check is not a run of passes.
    expect(cases.filter(([call, request]) => !validator(`${call}.request`)(request)).length).toBeGreaterThan(
      35,
    );
  });

  it("refuses what the schema leaves to code: days and times that do not exist", () => {
    const write = structuredClone(exchange("server-write-parquet.json").request);
    write.day = "2026-02-30";
    expect(validator("serverWrite.request")(write)).toBe(true);
    expect(checkServerWriteRequest(write).problems).toEqual(["request.day is not a calendar day"]);
    const erase = structuredClone(exchange("delete-erasure.json").request);
    erase.erasure = { personId: "person-riley", checkedAt: "2026-10-26T25:00:00Z" };
    expect(validator("deleteObject.request")(erase)).toBe(true);
    expect(checkDeleteObjectRequest(erase).problems).toEqual(["request.erasure.checkedAt is not a UTC time"]);
  });

  it("names the field in each problem, never a value", () => {
    const values = [
      "person-sam",
      "biz-lees-barbershop",
      "public",
      "samleeidphotofrontpage001",
      "image/svg+xml",
    ];
    const requests: [FilesCallName, unknown][] = [
      ["uploadLink", "person-sam"],
      ["uploadLink", { ...exchange("invalid/refuse-caller-names-key.json").request, visibility: "public" }],
      ["uploadLink", { ...exchange("invalid/refuse-svg-upload.json").request }],
      ["readLink", { objectKey: "biz-lees-barbershop", viewer: { as: "person-sam" } }],
      ["deleteObject", { reason: "public" }],
    ];
    for (const [call, request] of requests) {
      const { problems } = CHECKS[call](request);
      expect(problems.length).toBeGreaterThan(0);
      for (const value of values) expect(problems.join("\n")).not.toContain(value);
    }
  });

  it("refuses a write body that is not the request's bytes", async () => {
    const body = new TextEncoder().encode("sealed bytes");
    const request = {
      ...(structuredClone(
        exchange("server-write-sealed-trace.json").request,
      ) as unknown as ServerWriteRequest),
      sizeBytes: body.byteLength,
      sha256: await sha256Hex(body),
    };
    expect(await writeBodyProblems(request, body)).toEqual([]);
    expect(await writeBodyProblems(request, body.slice(1))).toEqual(["body is not request.sizeBytes long"]);
    const other = body.slice();
    other[0] = 0;
    expect(await writeBodyProblems(request, other)).toEqual(["body's sha256 is not request.sha256"]);
    expect(await writeBodyProblems(request, [...body])).toEqual(["body is not bytes"]);
  });
});

describe("the port's rules", () => {
  it("gives each upload kind its types and each write kind the types, owners and sources the schema gives it", () => {
    for (const kind of UPLOAD_KINDS)
      expect(uploadTypesFor(kind)).toEqual(
        kind === "photo"
          ? ["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"]
          : ["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", "application/pdf"],
      );
    const base = structuredClone(exchange("server-write-done-photo.json").request);
    const owners = {
      person: { kind: "person", personId: "person-alex", businessId: null },
      business: { kind: "business", businessId: "biz-lee-home-services" },
      booking: base.owner,
      rosie: { kind: "rosie" },
    };
    const types = validator("mediaType").schema as { enum: string[] };
    for (const kind of WRITE_KINDS)
      for (const mediaType of types.enum)
        for (const [ownerKind, owner] of Object.entries(owners))
          for (const source of [
            { kind: "rosie" },
            { kind: "linq", eventId: "evt-1", attachmentId: "att-1" },
          ]) {
            const request = { ...base, kind, mediaType, owner, source };
            const rules = WRITE_RULES[kind];
            const ours =
              (rules.mediaTypes as readonly string[]).includes(mediaType) &&
              (rules.owners as readonly string[]).includes(ownerKind) &&
              (rules.sources as readonly string[]).includes(source.kind);
            expect(
              validator("serverWrite.request")(request),
              JSON.stringify([kind, mediaType, ownerKind, source.kind]),
            ).toBe(ours);
            expect(checkServerWriteRequest(request).problems.length === 0).toBe(ours);
          }
  });

  it("answers uploadLink's refusals type first, then size, at exactly 10 MiB", () => {
    expect(uploadLinkRefusal({ kind: "photo", mediaType: "application/pdf", sizeBytes: 20_000_000 })).toEqual(
      {
        error: "wrongType",
        allowed: uploadTypesFor("photo"),
      },
    );
    expect(
      uploadLinkRefusal({ kind: "form", mediaType: "application/pdf", sizeBytes: UPLOAD_MAX_BYTES }),
    ).toBeNull();
    expect(
      uploadLinkRefusal({ kind: "form", mediaType: "application/pdf", sizeBytes: UPLOAD_MAX_BYTES + 1 }),
    ).toEqual({
      error: "tooLarge",
      maxBytes: 10_485_760,
    });
  });

  it("answers checkUpload's refusals from the bytes, each with the file removed", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const asked = { mediaType: "image/jpeg", maxBytes: UPLOAD_MAX_BYTES } as const;
    expect(storedFileRefusal({ sizeBytes: 2_400_000, leading: jpeg }, asked)).toBeNull();
    expect(
      storedFileRefusal({ sizeBytes: 2_400_000, leading: new TextEncoder().encode("%PDF-") }, asked),
    ).toEqual({
      error: "wrongType",
      allowed: ["image/jpeg"],
      removed: true,
    });
    expect(storedFileRefusal({ sizeBytes: UPLOAD_MAX_BYTES + 1, leading: jpeg }, asked)).toEqual({
      error: "tooLarge",
      maxBytes: UPLOAD_MAX_BYTES,
      sizeBytes: UPLOAD_MAX_BYTES + 1,
      removed: true,
    });
  });

  it("ends a link its life after the call, in whole seconds, and it works before its end only", () => {
    expect(linkExpiresAt(new Date("2026-10-19T14:30:30Z"), 900)).toBe("2026-10-19T14:45:30Z");
    expect(linkExpiresAt(new Date("2026-10-20T15:02:00.080Z"), 300)).toBe("2026-10-20T15:07:00Z");
    expect(linkIsLive("2026-10-20T15:07:00Z", new Date("2026-10-20T15:06:59.999Z"))).toBe(true);
    expect(linkIsLive("2026-10-20T15:07:00Z", new Date("2026-10-20T15:07:00Z"))).toBe(false);
  });
});

describe("the span (K-13 v1 filesSpan)", () => {
  it("rebuilds span-upload-link.json from its request and answer, and writes no key, link or hash", () => {
    const fx = readJson(FIXTURES, "span-upload-link.json") as Record<string, unknown> & { at: string };
    const request = exchange("upload-id-document.json");
    const span = buildFilesSpan({
      call: "uploadLink",
      trace: TRACE,
      at: new Date(fx.at),
      ms: 6,
      attempt: 1,
      step: "S1-10",
      got: { kind: "idDocument", owner: "person", mediaType: "image/jpeg", sizeBytes: 2_400_000 },
      outcome: request.outcome as unknown as UploadLinkOutcome,
    });
    expect(validator("filesSpan")(span)).toBe(true);
    expect(span).toEqual({ ...fx, event_id: null });
    expect(JSON.stringify(span)).not.toContain("q7m2k9x4t8v1c6b3n5p0r2s4w6");
  });

  it("names an error as the span's error_code with no decided: refused, failed or timedOut", () => {
    const base = {
      call: "readLink",
      trace: TRACE,
      at: new Date("2026-11-02T09:15:30Z"),
      ms: 3,
      attempt: 1,
      got: { kind: "licenseFile" },
    } as const;
    const notFound = buildFilesSpan({ ...base, outcome: { error: "notFound" } });
    const failed = buildFilesSpan({ ...base, outcome: { error: "unavailable" } });
    const timedOut = buildFilesSpan({ ...base, outcome: { error: "unavailable" }, timedOut: true });
    expect(
      [notFound, failed, timedOut].map((span) => [span.outcome, span.error_code, "decided" in span]),
    ).toEqual([
      ["refused", "notFound", false],
      ["failed", "unavailable", false],
      ["timedOut", "unavailable", false],
    ]);
    for (const span of [notFound, failed, timedOut]) expect(validator("filesSpan")(span)).toBe(true);
  });

  it("decides each answer in labels and counts", () => {
    expect(
      endedOf({
        result: "ready",
        objectKey: "x",
        url: "https://x",
        method: "PUT",
        contentType: "image/png",
        maxBytes: 1,
        expiresAt: "x",
      }),
    ).toEqual({
      decided: { result: "ready" },
    });
    expect(endedOf({ result: "stored", sizeBytes: 9, mediaType: "image/png", storedAt: "x" })).toEqual({
      decided: { result: "stored", sizeBytes: 9 },
    });
    expect(endedOf({ result: "stored", objectKey: "x", storedAt: "x", repeated: true })).toEqual({
      decided: { result: "stored", repeated: true },
    });
    expect(endedOf({ result: "notStored" })).toEqual({ decided: { result: "notStored" } });
    expect(
      endedOf({ result: "link", url: "https://x", expiresAt: "x", disposition: "attachment", noSniff: true }),
    ).toEqual({ decided: { result: "link" } });
    expect(endedOf({ result: "read", mediaType: "text/csv", sizeBytes: 3 })).toEqual({
      decided: { result: "read", sizeBytes: 3 },
    });
    expect(endedOf({ result: "deleted", alreadyGone: false })).toEqual({
      decided: { result: "deleted", alreadyGone: false },
    });
    expect(endedOf({ error: "conflict" })).toEqual({ errorCode: "conflict" });
  });

  it("reads a view back from a readLink span that gave a link, and from no other span", () => {
    const fx = readJson(FIXTURES, "span-read-link-logged.json") as Parameters<typeof viewRecordOf>[0];
    expect(viewRecordOf(fx)).toEqual({
      at: "2026-10-20T15:02:00.080Z",
      traceId: "trace-portal-sam-0031",
      spanId: "span-portal-sam-0031-02",
      kind: "licenseFile",
      as: "business",
      viewer: "person-sam",
      fileTable: "document_files",
      fileRow: "docfile-riley-barber-license-photo",
    });
    const other = (change: Record<string, unknown>): Parameters<typeof viewRecordOf>[0] => ({
      ...fx,
      ...change,
    });
    for (const span of [
      readJson(FIXTURES, "span-upload-link.json") as typeof fx,
      readJson(FIXTURES, "span-delete-erasure.json") as typeof fx,
      other({ outcome: "refused", error_code: "notFound", decided: undefined }),
      other({ decided: { result: "read" } }),
      other({ provider: "google_places" }),
      other({ got: { ...fx.got, as: "customer" } }),
      other({ got: { kind: "licenseFile" } }),
    ])
      expect(viewRecordOf(span)).toBeNull();
    // A span of another port named readLink is no view either.
    const places = buildOutsideCallSpan({
      traceId: "trace-linq-1",
      spanId: "span-linq-1",
      seq: 1,
      hop: "portCall",
      at: new Date("2026-10-20T15:02:00Z"),
      ms: 0,
      bundleId: TRACE.bundleId,
      turnId: null,
      handleRef: null,
      provider: "linq",
      call: "readLink",
      attempt: 1,
      got: fx.got ?? {},
      decided: { result: "link" },
      outcome: "ok",
    });
    expect(viewRecordOf(places)).toBeNull();
  });
});
