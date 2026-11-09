// How the gold store writes a JSON file, and how it hashes one (T-470).
//
// A set's files are committed under evals/gold/, which `npm run format:check` (prettier --check .) reads, so each file
// is written exactly as Prettier formats it with this repository's settings (.prettierrc.json and .editorconfig, read
// for a path under evals/gold/ wherever the store writes, so a store in a scratch folder writes the same bytes). The
// text Prettier is given is the value's compact JSON, keys in the order the value has them, so the same value always
// gives the same bytes. The parser is the one Prettier picks for the file's own name, as the check does.
//
// A file's hash is the sha256 of its UTF-8 bytes in lowercase hex (K-01 v1 sha256; Q-36), so `shasum -a 256 <file>`
// gives the hash the manifest lists.
import { createHash } from "node:crypto";
import path from "node:path";

import { format, resolveConfig, type Options } from "prettier";

import { GOLD_ROOT, MANIFEST_FILE } from "./layout";

let settings: Promise<Options> | null = null;

/** The repository's Prettier settings for a JSON file under evals/gold/ (read once). */
export function prettierSettings(): Promise<Options> {
  settings ??= resolveConfig(path.join(GOLD_ROOT, MANIFEST_FILE), { editorconfig: true }).then(
    (found) => found ?? {},
  );
  return settings;
}

/** The text the store writes for `value` at `file`: its JSON as Prettier formats it here, ending in a newline. */
export async function jsonFileText(value: unknown, file: string): Promise<string> {
  const json = JSON.stringify(value) as string | undefined;
  if (json === undefined) throw new TypeError(`${file}: the value is not JSON`);
  return format(json, { ...(await prettierSettings()), filepath: file });
}

/** The sha256 of text's UTF-8 bytes, in lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
