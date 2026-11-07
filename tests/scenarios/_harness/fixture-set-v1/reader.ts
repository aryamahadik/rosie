// The only file of the loader that touches the file system for test data. Every read goes through FixtureReader,
// which is bound to one fixtures/v1 folder: a path that leaves it is refused (rule 9: test data comes only from
// fixture set v1), and each path read is recorded so a test can check the list.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The fixtures/v1 folder of this repository: this file is tests/scenarios/_harness/fixture-set-v1/reader.ts. */
export const FIXTURES_V1_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "v1",
);

/** The check of fixture set v1 (T-002), always the one committed in this repository. */
export const VERIFY_SCRIPT = path.join(FIXTURES_V1_ROOT, "tools", "verify.mjs");

/** Any reason the loader will not hand out fixture data: verify failed, a file is not the shape expected, a path left the folder. */
export class FixtureSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureSetError";
  }
}

export class FixtureReader {
  readonly root: string;
  private readonly log: string[] = [];

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** The paths read so far, relative to the root, posix. */
  get reads(): readonly string[] {
    return [...this.log];
  }

  private resolve(relative: string): string {
    const parts = relative.split("/");
    if (path.isAbsolute(relative) || parts.includes("..") || parts.includes("")) {
      throw new FixtureSetError(`path is not inside fixtures/v1: ${relative}`);
    }
    const absolute = path.join(this.root, ...parts);
    if (!absolute.startsWith(this.root + path.sep)) {
      throw new FixtureSetError(`path is not inside fixtures/v1: ${relative}`);
    }
    return absolute;
  }

  /** A file's text, UTF-8. */
  readText(relative: string): string {
    const absolute = this.resolve(relative);
    this.log.push(relative);
    return readFileSync(absolute, "utf8");
  }

  /** The names in a folder, sorted by code point. */
  listDir(relative: string): string[] {
    const absolute = this.resolve(relative);
    this.log.push(`${relative}/`);
    return readdirSync(absolute).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
}
