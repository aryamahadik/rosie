// Spike T-131: load a CommonJS script from an ES module without editing it.
//
// Why it is needed: the repo root package.json says "type": "module", so Node reads every .js file below it as an
// ES module. The master's scripts are CommonJS and fail there (see probe-plain.mjs). This loader gives a script
// exactly what Node's own CommonJS loader gives it: `exports`, `require`, `module`, `__filename`, `__dirname`, and
// `this` equal to `module.exports`. A relative require("./x") goes through this same loader; any other require
// ("fs", "path", "crypto") goes to Node's own require.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compileFunction } from "node:vm";

const nodeRequire = createRequire(import.meta.url);

/** @param {Map<string, {exports: unknown}>} [cache] */
export function makeLoader(cache = new Map()) {
  /** @param {string} file absolute path of a CommonJS .js file */
  function load(file) {
    const hit = cache.get(file);
    if (hit) return hit.exports;
    const module = { exports: {}, id: file, filename: file, loaded: false };
    cache.set(file, module);
    const source = readFileSync(file, "utf8");
    const fn = compileFunction(source, ["exports", "require", "module", "__filename", "__dirname"], {
      filename: file,
    });
    const dir = dirname(file);
    const req = (/** @type {string} */ id) => {
      if (id.startsWith("./") || id.startsWith("../")) {
        const target = resolve(dir, id);
        return load(target.endsWith(".js") ? target : target + ".js");
      }
      return nodeRequire(id);
    };
    fn.call(module.exports, module.exports, req, module, file, dir);
    module.loaded = true;
    return module.exports;
  }
  return load;
}
