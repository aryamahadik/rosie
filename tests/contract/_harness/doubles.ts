// Test-double loader (T-003; 02-contracts section 2 item 12: a producer is checked through its double).
//
// A double is a module in the repository that stands in for one outside service (a port, in the contracts'
// words). This loader finds it by the port's name. It knows a double only through its DoubleSpec:
//
//   { port: "<port name>", module: "<path from the repository root>", exports: ["<name>", ...] }
//
//   - port: lower-case letters, digits and hyphens, starting with a letter, unique in the registry;
//   - module: a relative posix path inside the repository ending in .ts, .mjs or .js. The module is imported
//     as it is; this loader never writes or generates one;
//   - exports: the names the module must export. A module that lacks one is refused with the missing names, so
//     a test never runs against a half-written double.
//
// The loader invents no port's shape: what a double's exports do is the port contract's business (the
// integrations engineer writes the doubles, the architect the contracts). When a real double merges, QA adds
// one spec to DOUBLE_SPECS in registry.ts. Until then asking for that port fails with "not written yet".
//
// The scenario and end-to-end harnesses (tests/scenarios/_harness, tests/e2e/_harness) use the same loader.

import { existsSync } from "node:fs";
import path from "node:path";

import { REPO_ROOT } from "./fixtures";

export interface DoubleSpec {
  /** The port's name, as the contracts spell it. */
  readonly port: string;
  /** The double's module: a relative posix path from the repository root. */
  readonly module: string;
  /** The names the module must export. */
  readonly exports: readonly string[];
}

/** What a loaded double module exports. */
export type DoubleModule = Readonly<Record<string, unknown>>;

export interface DoubleLoaderOptions {
  /** The folder `module` paths are relative to. Default: this repository's root. */
  readonly root?: string;
}

export interface DoubleLoader {
  /** The registered port names, sorted. */
  ports(): string[];
  /** The spec of one port; throws DoubleLoadError for an unknown port. */
  spec(port: string): DoubleSpec;
  /** Imports the port's double and checks its exports; throws DoubleLoadError on any problem. */
  load(port: string): Promise<DoubleModule>;
}

/** Every problem loading a double, with the port it concerns in the message. */
export class DoubleLoadError extends Error {
  readonly port: string;

  constructor(port: string, message: string, options?: ErrorOptions) {
    super(`double for port "${port}": ${message}`, options);
    this.name = "DoubleLoadError";
    this.port = port;
  }
}

const PORT_NAME = /^[a-z][a-z0-9-]*$/;
const MODULE_PATH = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*[.](ts|mjs|js)$/;
const EXPORT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function checkSpec(spec: DoubleSpec): void {
  if (!PORT_NAME.test(spec.port)) {
    throw new DoubleLoadError(
      spec.port,
      "a port name is lower-case letters, digits and hyphens, starting with a letter",
    );
  }
  if (
    !MODULE_PATH.test(spec.module) ||
    spec.module.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new DoubleLoadError(
      spec.port,
      `module "${spec.module}" must be a relative path inside the repository ending in .ts, .mjs or .js`,
    );
  }
  if (spec.exports.length === 0) {
    throw new DoubleLoadError(spec.port, "name at least one export the module must have");
  }
  for (const name of spec.exports) {
    if (!EXPORT_NAME.test(name)) throw new DoubleLoadError(spec.port, `"${name}" is not an export name`);
  }
}

/** Builds a loader over `specs`. A bad spec or a repeated port name throws at once, not at the first load. */
export function createDoubleLoader(
  specs: readonly DoubleSpec[],
  options: DoubleLoaderOptions = {},
): DoubleLoader {
  const root = options.root ?? REPO_ROOT;
  const byPort = new Map<string, DoubleSpec>();
  for (const spec of specs) {
    checkSpec(spec);
    if (byPort.has(spec.port)) throw new DoubleLoadError(spec.port, "is registered twice");
    byPort.set(spec.port, spec);
  }
  const spec = (port: string): DoubleSpec => {
    const found = byPort.get(port);
    if (found === undefined) {
      const known = [...byPort.keys()].sort().join(", ");
      throw new DoubleLoadError(
        port,
        `no such port is registered (registered: ${known === "" ? "none" : known})`,
      );
    }
    return found;
  };
  return {
    ports: () => [...byPort.keys()].sort(),
    spec,
    async load(port) {
      const { module: modulePath, exports: expected } = spec(port);
      const absolute = path.join(root, ...modulePath.split("/"));
      if (!existsSync(absolute)) {
        throw new DoubleLoadError(port, `${modulePath} is not written yet`);
      }
      let loaded: DoubleModule;
      try {
        loaded = (await import(/* @vite-ignore */ absolute)) as DoubleModule;
      } catch (error) {
        throw new DoubleLoadError(port, `${modulePath} could not be imported`, { cause: error });
      }
      const missing = expected.filter((name) => loaded[name] === undefined);
      if (missing.length > 0) {
        throw new DoubleLoadError(port, `${modulePath} does not export ${missing.join(", ")}`);
      }
      return loaded;
    },
  };
}
