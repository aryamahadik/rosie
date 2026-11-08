// The bundle id's content hash and build number (T-150; C-072; CQ-09; K-01 v1 manifest.bundleId).
//
// CQ-09's default: a bundle id is a content hash of the compiled files plus a build number, and every published bundle
// stays readable for replay (tour line 658). K-01 v1 spells the hash (manifest.bundleId; contracts/bundle/README.md,
// "Storage"): the sha256, in lowercase hex, of the UTF-8 text made of one line
// `<sha256 of the value>  <key after bundle/<hash>/<build>/>` per stored value, sorted by that key part, each line ending
// in a newline. The stored values are the flow graphs and the trade overlays (K-01 storedValue: "one KV value of the
// bundle besides the manifest"), so the manifest, which carries the id and the build time, is not hashed. Equal
// compiled files give an equal hash; a changed byte in one value changes it. The build number counts publishes from 1
// (K-01 manifest.bundleId.build); the publish picks it (T-152), and a build is given it.
//
//   contentHash()              the hash of the stored values' key parts and sha256s.
//   storedDigestsOfFiles()     those of an emitted bundle's files: every file but manifest.json, at its key part.
//   storedDigestsOfManifest()  those a manifest's storage table lists, each key's part after the manifest's bundle id.
//   bundleIdProblems()         what is wrong with a manifest's bundle id: not the content hash of the stored values its
//                              storage lists, a build number that does not count from 1, a key under another id. None:
//                              the id holds, so a reader can tell the bundle's values are the ones the id names.
//   parseBuildNumber()         a build number from text: a whole number from 1.
import { createHash } from "node:crypto";
import type { BundleFile, BundleId } from "../emit";

type Obj = Record<string, unknown>;

/** One stored value as the bundle id's hash reads it: its key part (flow/A, trade/barber) and its sha256. */
export interface StoredDigest {
  part: string;
  sha256: string;
}

/** A value the bundle id rules refuse: no stored value, a part listed twice, a malformed part, hash or build number. */
export class BundleIdError extends Error {
  override name = "BundleIdError";
}

/** A sha256 as K-01 spells it: 64 lowercase hex characters (K-01 sha256). */
const SHA256 = /^[0-9a-f]{64}$/;

/** A stored value's key part: flow/<A or B> or trade/<trade id> (K-01 kvKey and storedValue; Q-34's layout). */
const PART = /^(flow\/[AB]|trade\/[a-z0-9][a-z0-9-]*)$/;

/** The file of the manifest in a bundle directory (emit.ts): not a stored value, so not hashed. */
const MANIFEST_FILE = "manifest.json";

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The sha256 of text's UTF-8 bytes, or of bytes as they are, in lowercase hex (Q-36's hash). */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** A build number: a whole number from 1 (K-01 manifest.bundleId.build, "counting publishes from 1"). */
export function isBuildNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** The build number `text` writes: digits with no leading zero, from 1. Throws BundleIdError on anything else. */
export function parseBuildNumber(text: string): number {
  const build = Number(text);
  if (!/^[1-9][0-9]*$/.test(text) || !isBuildNumber(build))
    throw new BundleIdError(`"${text}" is not a build number (a whole number from 1)`);
  return build;
}

/**
 * The bundle id's hash of `values` (K-01 manifest.bundleId): the sha256 of one line `<sha256>  <part>` per value,
 * sorted by part, each line ending in a newline. The order `values` come in does not matter; each part counts once.
 */
export function contentHash(values: readonly StoredDigest[]): string {
  if (values.length === 0)
    throw new BundleIdError("a bundle id hashes at least one stored value (K-01 storage.values)");
  const parts = new Set<string>();
  for (const value of values) {
    if (!PART.test(value.part))
      throw new BundleIdError(`"${value.part}" is not a stored value's key part (flow/<A or B>, trade/<id>)`);
    if (!SHA256.test(value.sha256))
      throw new BundleIdError(`${value.part}: "${value.sha256}" is not a sha256 in lowercase hex`);
    if (parts.has(value.part)) throw new BundleIdError(`${value.part} is listed twice`);
    parts.add(value.part);
  }
  const lines = [...values]
    .sort((a, b) => (a.part < b.part ? -1 : a.part > b.part ? 1 : 0))
    .map((value) => `${value.sha256}  ${value.part}\n`);
  return sha256Hex(lines.join(""));
}

/** The stored values of an emitted bundle's files: each file but manifest.json, at its path without `.json`. */
export function storedDigestsOfFiles(files: readonly BundleFile[]): StoredDigest[] {
  const out: StoredDigest[] = [];
  for (const file of files) {
    if (file.path === MANIFEST_FILE) continue;
    if (!file.path.endsWith(".json")) throw new BundleIdError(`${file.path} is not a bundle file`);
    out.push({ part: file.path.slice(0, -".json".length), sha256: sha256Hex(file.text) });
  }
  return out;
}

/** The content hash of an emitted bundle's files (contentHash of storedDigestsOfFiles). */
export function contentHashOfFiles(files: readonly BundleFile[]): string {
  return contentHash(storedDigestsOfFiles(files));
}

/** The key prefix of a bundle id: bundle/<hash>/<build>/ (K-01 kvKey). */
export function keyPrefix(id: BundleId): string {
  return `bundle/${id.hash}/${String(id.build)}/`;
}

/** The bundle id a manifest names, or a line saying why it names none. */
function idOf(manifest: unknown): BundleId | string {
  if (!isObj(manifest) || !isObj(manifest.bundleId)) return "the manifest has no bundleId";
  const { hash, build } = manifest.bundleId;
  if (typeof hash !== "string" || !SHA256.test(hash)) return "bundleId.hash is not a sha256 in lowercase hex";
  if (!isBuildNumber(build)) return "bundleId.build is not a build number (a whole number from 1)";
  return { hash, build };
}

/**
 * The stored values a manifest's storage table lists: each value's key part after the manifest's bundle id, with its
 * sha256. Throws BundleIdError when the manifest names no bundle id or a key is not under it.
 */
export function storedDigestsOfManifest(manifest: unknown): StoredDigest[] {
  const id = idOf(manifest);
  if (typeof id === "string") throw new BundleIdError(id);
  const storage = (manifest as Obj).storage;
  const values = isObj(storage) ? storage.values : undefined;
  if (!Array.isArray(values)) throw new BundleIdError("the manifest has no storage.values");
  const prefix = keyPrefix(id);
  return (values as unknown[]).map((value, k) => {
    if (!isObj(value) || typeof value.key !== "string" || typeof value.sha256 !== "string")
      throw new BundleIdError(`storage.values[${String(k)}] has no key and sha256`);
    if (!value.key.startsWith(prefix))
      throw new BundleIdError(`${value.key} is not under the bundle id ${prefix}`);
    return { part: value.key.slice(prefix.length), sha256: value.sha256 };
  });
}

/**
 * What is wrong with a manifest's bundle id (see the top of this file), one line each; an empty list: its hash is
 * the content hash of the stored values its storage lists, its build number counts from 1, and every key, its own
 * among them, is under it.
 */
export function bundleIdProblems(manifest: unknown): string[] {
  const id = idOf(manifest);
  if (typeof id === "string") return [id];
  const problems: string[] = [];
  const storage = (manifest as Obj).storage;
  const prefix = keyPrefix(id);
  if (!isObj(storage) || storage.manifestKey !== `${prefix}manifest`)
    problems.push(`storage.manifestKey is not ${prefix}manifest`);
  let hash: string;
  try {
    hash = contentHash(storedDigestsOfManifest(manifest));
  } catch (error) {
    if (!(error instanceof BundleIdError)) throw error;
    return [...problems, error.message];
  }
  if (hash !== id.hash)
    problems.push(`bundleId.hash is ${id.hash}, but the content hash of the stored values listed is ${hash}`);
  return problems;
}
