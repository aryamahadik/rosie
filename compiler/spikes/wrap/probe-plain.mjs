// Spike T-131, probe 1: do the vendored CommonJS scripts load unchanged by the ordinary routes?
// Usage: node compiler/spikes/wrap/probe-plain.mjs
// It tries `import()` and `createRequire` on each script, and prints the first line of each error.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const build = new URL("../../../fixtures/master/engine/work/build/", import.meta.url);
const require = createRequire(import.meta.url);

for (const name of ["msgtext.js", "overlay-core.js", "lib.js"]) {
  const file = fileURLToPath(new URL(name, build));
  try {
    const ns = await import(file);
    console.log(`import()        ${name}: ok (keys: ${Object.keys(ns).slice(0, 4).join(",")}...)`);
  } catch (e) {
    console.log(
      `import()        ${name}: ${e instanceof Error ? e.name + ": " + e.message.split("\n")[0] : String(e)}`,
    );
  }
  try {
    const m = require(file);
    console.log(`createRequire   ${name}: ok (${typeof m})`);
  } catch (e) {
    console.log(
      `createRequire   ${name}: ${e instanceof Error ? e.name + ": " + e.message.split("\n")[0] : String(e)}`,
    );
  }
}
console.log(`(spike folder: ${here})`);
