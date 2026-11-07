// Loads a CommonJS script from an ES module without editing it (T-131 answered WRAP; this is the spike's loader,
// compiler/spikes/wrap/cjs-load.mjs, copied here and typed).
//
// Why it is needed: the repo root package.json says "type": "module", so Node reads every .js file below it as an ES
// module, and the master's scripts are CommonJS (a plain import or createRequire fails on them). This loader gives a
// script exactly what Node's own CommonJS loader gives it: `exports`, `require`, `module`, `__filename`, `__dirname`,
// and `this` equal to `module.exports`. A relative require("./x") goes through this same loader; any other require
// ("fs", "path") goes to Node's own require.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { compileFunction } from "node:vm";

interface CjsModule {
  exports: unknown;
  id: string;
  filename: string;
  loaded: boolean;
}

/** Loads one CommonJS file by absolute path and returns its `module.exports`. */
export type CjsLoader = (file: string) => unknown;

const nodeRequire = createRequire(import.meta.url);

/** A loader with its own module cache: two loaders hold two separate copies of the same script. */
export function makeCjsLoader(cache = new Map<string, CjsModule>()): CjsLoader {
  function load(file: string): unknown {
    const hit = cache.get(file);
    if (hit) return hit.exports;
    const module: CjsModule = { exports: {}, id: file, filename: file, loaded: false };
    cache.set(file, module);
    const source = readFileSync(file, "utf8");
    const fn = compileFunction(source, ["exports", "require", "module", "__filename", "__dirname"], {
      filename: file,
    }) as (this: unknown, ...args: unknown[]) => void;
    const dir = dirname(file);
    const req = (id: string): unknown => {
      if (id.startsWith("./") || id.startsWith("../")) {
        const target = resolve(dir, id);
        return load(target.endsWith(".js") ? target : `${target}.js`);
      }
      return nodeRequire(id);
    };
    fn.call(module.exports, module.exports, req, module, file, dir);
    module.loaded = true;
    return module.exports;
  }
  return load;
}
