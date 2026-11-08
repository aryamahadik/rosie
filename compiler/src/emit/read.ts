// A written bundle directory, read back and checked (T-149): what `compiler build` does after it writes, so the bundle
// on disk, not only the one in memory, is the one that validates against K-01 v1.
//
//   readBundleDir()   the files of a bundle directory (manifest.json, flow/A.json, flow/B.json, trade/<id>.json) and
//                     the K-01 root document they make. Any other file is refused: the folder holds a bundle only.
//   checkBundleDir()  the problems of that document against K-01 v1 (validate.ts), and of the manifest's storage table
//                     against the files: each stored value's key under the manifest's bundle id, its size and its
//                     sha256, one file per value and one value per file. An empty list: the bundle is sound.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { BundleFile } from "./emit";
import { checkBundlePart } from "./validate";

type Obj = Record<string, unknown>;

const FILE = /^(manifest|flow\/[AB]|trade\/[a-z0-9][a-z0-9-]*)\.json$/;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every file under `dir`, by its path from `dir` (posix), sorted. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(relative(dir, path).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** A bundle directory read back: its files, and the K-01 root document ({ manifest, flows, trades }) they make. */
export function readBundleDir(dir: string): { files: BundleFile[]; bundle: Obj } {
  const files: BundleFile[] = [];
  const flows: Obj = {};
  const trades: Obj = {};
  let manifest: unknown = undefined;
  for (const path of filesUnder(dir)) {
    if (!FILE.test(path))
      throw new Error(
        `${dir}: ${path} is not a bundle file (manifest.json, flow/<A|B>.json, trade/<id>.json)`,
      );
    const text = readFileSync(join(dir, ...path.split("/")), "utf8");
    files.push({ path, text });
    const value = JSON.parse(text) as unknown;
    const [kind, name = ""] = path.replace(/\.json$/, "").split("/");
    if (kind === "manifest") manifest = value;
    else if (kind === "flow") flows[name] = value;
    else trades[name] = value;
  }
  if (manifest === undefined) throw new Error(`${dir}: no manifest.json`);
  return { files, bundle: { manifest, flows, trades } };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The problems of a written bundle directory (see the top of this file); none: it is sound. */
export function checkBundleDir(dir: string): string[] {
  const { files, bundle } = readBundleDir(dir);
  const problems = checkBundlePart(bundle).map((problem) => `K-01 v1: ${problem}`);
  const manifest = bundle.manifest;
  if (!isObj(manifest) || !isObj(manifest.bundleId) || !isObj(manifest.storage)) return problems;
  const { hash, build } = manifest.bundleId as { hash: unknown; build: unknown };
  const prefix = `bundle/${String(hash)}/${String(build)}/`;
  const storage = manifest.storage as { manifestKey?: unknown; values?: unknown };
  if (storage.manifestKey !== `${prefix}manifest`)
    problems.push(`storage.manifestKey is not ${prefix}manifest`);
  const byPath = new Map(files.map((file) => [file.path, file.text]));
  const listed = new Set<string>(["manifest.json"]);
  for (const entry of Array.isArray(storage.values) ? (storage.values as unknown[]) : []) {
    if (!isObj(entry) || typeof entry.key !== "string") continue;
    if (!entry.key.startsWith(prefix)) {
      problems.push(`${entry.key} is not under the bundle id ${prefix}`);
      continue;
    }
    const path = `${entry.key.slice(prefix.length)}.json`;
    listed.add(path);
    const text = byPath.get(path);
    if (text === undefined) {
      problems.push(`${entry.key}: no file ${path}`);
      continue;
    }
    if (entry.bytes !== new TextEncoder().encode(text).length)
      problems.push(`${path}: ${String(entry.bytes)} bytes listed, the file has another size`);
    if (entry.sha256 !== sha256(text)) problems.push(`${path}: the sha256 listed is not the file's`);
  }
  for (const file of files)
    if (!listed.has(file.path)) problems.push(`${file.path} is not a stored value of the manifest`);
  return problems;
}
