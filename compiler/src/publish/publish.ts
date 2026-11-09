// Publishing a bundle (T-152; C-072): a bundle directory written by `compiler build --build <n>` goes out under its
// bundle id twice over (K-01 v1 "Storage"; arch 10 lines 518, 536): as the KV bulk file the deploy script uploads to the
// bundle KV namespace, and as PostgreSQL's copy, which the actor reads on a KV miss (K-05 v1 item 7; NQ-PB-5's default).
//
//   readPublishable()  the directory read back and checked as `compiler build` checks what it wrote (T-149: K-01 v1, and
//                      each file the value the manifest's storage lists), its bundle id the content hash of its stored
//                      values (T-150). Its parts are the manifest, the flow graphs and the trade overlays, each under its
//                      K-01 key bundle/<hash>/<build>/<part> with the file's bytes exactly (T-151: one value per part).
//   kvBulkText()       the KV bulk file: a JSON array with one { key, value } entry per part, every key under the bundle
//                      id, the form `wrangler kv bulk put` reads.
//   checkKvFile()      the file's place: a new file outside the bundle directory, or one holding these entries already.
//   publishBundle()    PostgreSQL's copy through K-05's publishBundleCopy (db/repo/bundles.ts, T-185: the registry row,
//                      not active, and every part, in one transaction); every part read back by its key through K-05's
//                      readBundleValue, the actor's read on a KV miss, and compared byte for byte; then the KV bulk file.
//                      The same bundle again writes nothing new: K-05 answers `repeated`, and the file holding these
//                      entries is left as it is. Other bytes under the bundle id are refused (K-05 `valueMismatch`) and
//                      nothing is written, the KV bulk file included, so no upload can overwrite a key (K-01: keys are
//                      written once).
//   readBack()         that read back: one line per part whose copy is not the part's bytes.
//
// The active bundle id is never switched here (K-05 setActiveBundle is the deploy script's step 3, after the KV upload:
// BP 5.4; NQ-PB-5's default), and nothing here uploads to KV: both are the deploy script's (C-020).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  publishBundleCopy,
  readActiveBundle,
  readBundleValue,
  type ReadActiveBundleResult,
} from "../../../db/repo/bundles";
import type { Sql } from "../../../db/repo/scope";
import { bundleIdProblems, contentHashOfFiles, keyPrefix } from "../bundle-id";
import { checkBundleDir, readBundleDir, type BundleId } from "../emit";

type Obj = Record<string, unknown>;

/** The kinds of a bundle's parts (K-01 v1 storage; K-05 v1 storedText.kind). */
export type PartKind = "manifest" | "flow" | "trade";

/** One part of a bundle as it is published: one KV value and one value of PostgreSQL's copy. */
export interface BundlePart {
  /** Its K-01 key: bundle/<hash>/<build>/manifest, .../flow/<A or B> or .../trade/<trade id>. */
  key: string;
  kind: PartKind;
  /** Its file in the bundle directory: manifest.json, flow/A.json, trade/<id>.json. */
  path: string;
  /** The file's size in bytes. */
  bytes: number;
  /** The sha256 of the file's bytes, in lowercase hex. */
  sha256: string;
  /** The file's text: its UTF-8 bytes are the file's bytes exactly. */
  text: string;
}

/** A bundle directory read back and checked, ready to publish. */
export interface PublishableBundle {
  dir: string;
  bundleId: BundleId;
  builtAt: string;
  manifestKey: string;
  /** The manifest first, then the stored values in the order the manifest's storage lists them. */
  parts: BundlePart[];
}

/** One entry of the KV bulk file, as `wrangler kv bulk put` reads it: the key and the value's text. */
export interface KvBulkEntry {
  key: string;
  value: string;
}

/** What publishBundle() answers: published (or already published with these bytes), or K-05's refusal. */
export type PublishOutcome =
  | {
      result: "published";
      bundleId: BundleId;
      /** When PostgreSQL's copy was first published (K-05 publishBundleCopy). */
      publishedAt: string;
      /** True when the copy held these bytes already, so nothing new was written. */
      repeated: boolean;
      /** The values the copy holds for the bundle: one per part. */
      values: number;
      kvFile: string;
      /** False when the KV bulk file held these entries already and was left as it is. */
      kvFileWritten: boolean;
      /** The active bundle id read before and after the publish (K-05 readActiveBundle), which it never switches. */
      activeBefore: string;
      activeAfter: string;
    }
  | { error: "valueMismatch"; key: string }
  | { error: "transient"; sqlstate: string }
  | { error: "readBack"; problems: string[] };

/** A bundle directory, or a place for its KV bulk file, that is refused before anything is written. */
export class PublishError extends Error {
  override name = "PublishError";
}

// Fatal: a file that is not UTF-8 is refused, so each part's text gives the file's bytes back exactly (a BOM is kept).
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/** True when two byte strings are the same bytes. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k += 1) if (a[k] !== b[k]) return false;
  return true;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function kindOf(part: string): PartKind {
  if (part === "manifest") return "manifest";
  return part.startsWith("flow/") ? "flow" : "trade";
}

/** The part a bundle directory holds at `path`, under the key prefix of its bundle id, with the file's bytes. */
function partOf(dir: string, prefix: string, path: string): BundlePart {
  const raw = readFileSync(join(dir, ...path.split("/")));
  let text: string;
  try {
    text = decoder.decode(raw);
  } catch {
    throw new PublishError(`${dir}: ${path} is not UTF-8 text`);
  }
  const part = path.slice(0, -".json".length);
  return {
    key: `${prefix}${part}`,
    kind: kindOf(part),
    path,
    bytes: raw.length,
    sha256: createHash("sha256").update(raw).digest("hex"),
    text,
  };
}

/**
 * The bundle `compiler build --build <n>` wrote to `dir`, read back and checked (the top of this file). Throws
 * PublishError when it is not a sound bundle, or its id is not the content hash of its stored values.
 */
export function readPublishable(dir: string): PublishableBundle {
  let problems: string[];
  let read: ReturnType<typeof readBundleDir>;
  try {
    problems = checkBundleDir(dir);
    read = readBundleDir(dir);
  } catch (error) {
    throw new PublishError(`${dir} is not a bundle directory: ${messageOf(error)}`);
  }
  if (problems.length > 0)
    throw new PublishError(`${dir} is not a sound bundle: ${problems.slice(0, 5).join("; ")}`);
  const manifest = read.bundle.manifest as Obj;
  const idProblems = bundleIdProblems(manifest);
  if (idProblems.length > 0)
    throw new PublishError(
      `${dir}: its bundle id does not hold (${idProblems.join("; ")}); a bundle is published from a numbered build, compiler build --build <n>`,
    );
  const id = manifest.bundleId as BundleId;
  if (contentHashOfFiles(read.files) !== id.hash)
    throw new PublishError(`${dir}: the content hash of its files is not its bundle id's hash`);
  const prefix = keyPrefix(id);
  const storage = manifest.storage as { manifestKey: string; values: { key: string }[] };
  const paths = ["manifest.json", ...storage.values.map((value) => `${value.key.slice(prefix.length)}.json`)];
  return {
    dir,
    bundleId: { hash: id.hash, build: id.build },
    builtAt: manifest.builtAt as string,
    manifestKey: storage.manifestKey,
    parts: paths.map((path) => partOf(dir, prefix, path)),
  };
}

/** The KV bulk file's entries: one per part, in the bundle's order, each its K-01 key and its text. */
export function kvBulkEntries(bundle: PublishableBundle): KvBulkEntry[] {
  return bundle.parts.map((part) => ({ key: part.key, value: part.text }));
}

/** The KV bulk file's text: its entries as a JSON array. */
export function kvBulkText(bundle: PublishableBundle): string {
  return JSON.stringify(kvBulkEntries(bundle));
}

/** Where the KV bulk file goes when no place is given: beside the bundle directory, `<dir>.kv.json`. */
export function defaultKvFile(dir: string): string {
  return `${resolve(dir)}.kv.json`;
}

/**
 * Whether `file` holds `text` already (true) or does not exist yet (false). Throws PublishError for a place inside the
 * bundle directory, which holds the bundle's files only, for a place that is not a file, and for a file that holds other
 * bytes, which is never overwritten.
 */
export function checkKvFile(file: string, text: string, dir: string): boolean {
  const inside = relative(resolve(dir), resolve(file));
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside)))
    throw new PublishError(
      `${file} is inside the bundle directory ${dir}, which holds the bundle's files only`,
    );
  if (!existsSync(file)) return false;
  if (!statSync(file).isFile()) throw new PublishError(`${file} is not a file`);
  if (sameBytes(readFileSync(file), encoder.encode(text))) return true;
  throw new PublishError(
    `${file} already holds other entries, and it is never overwritten: give another place for this bundle's KV bulk file`,
  );
}

/** The active bundle id as K-05 readActiveBundle answers it, as a label. */
function activeLabel(answer: ReadActiveBundleResult): string {
  if ("result" in answer)
    return `${answer.bundleId.hash}/${String(answer.bundleId.build)} (active since ${answer.activatedAt})`;
  return answer.error === "noActiveBundle" ? "none" : `unreadable (transient, SQLSTATE ${answer.sqlstate})`;
}

/** Every part read back by its key (K-05 readBundleValue): one line per part whose copy is not the part's bytes. */
export async function readBack(sql: Sql, bundle: PublishableBundle): Promise<string[]> {
  const problems: string[] = [];
  for (const part of bundle.parts) {
    const answer = await readBundleValue(sql, { key: part.key });
    if ("error" in answer) {
      problems.push(`${part.key}: ${answer.error}`);
      continue;
    }
    const { value } = answer;
    const same =
      value.key === part.key &&
      value.kind === part.kind &&
      value.bytes === part.bytes &&
      value.sha256 === part.sha256 &&
      sameBytes(encoder.encode(value.text), encoder.encode(part.text));
    if (!same) problems.push(`${part.key}: PostgreSQL's copy is not the part's bytes`);
  }
  return problems;
}

/**
 * Publishes `bundle` (the top of this file): PostgreSQL's copy, read back by bundle id, then the KV bulk file at
 * `kvFile`. Throws PublishError, with nothing written, when the KV bulk file's place is refused (checkKvFile).
 */
export async function publishBundle(
  sql: Sql,
  bundle: PublishableBundle,
  kvFile: string,
): Promise<PublishOutcome> {
  const text = kvBulkText(bundle);
  const held = checkKvFile(kvFile, text, bundle.dir);
  const activeBefore = activeLabel(await readActiveBundle(sql));
  const answer = await publishBundleCopy(sql, {
    bundleId: bundle.bundleId,
    builtAt: bundle.builtAt,
    manifestKey: bundle.manifestKey,
    values: bundle.parts.map((part) => ({
      key: part.key,
      kind: part.kind,
      bytes: part.bytes,
      sha256: part.sha256,
      text: part.text,
    })),
  });
  if ("error" in answer) return answer;
  const problems = await readBack(sql, bundle);
  if (problems.length > 0) return { error: "readBack", problems };
  if (!held) {
    mkdirSync(dirname(kvFile), { recursive: true });
    writeFileSync(kvFile, text, { flag: "wx" });
  }
  const activeAfter = activeLabel(await readActiveBundle(sql));
  return {
    result: "published",
    bundleId: answer.bundleId,
    publishedAt: answer.publishedAt,
    repeated: answer.repeated,
    values: answer.values,
    kvFile,
    kvFileWritten: !held,
    activeBefore,
    activeAfter,
  };
}
