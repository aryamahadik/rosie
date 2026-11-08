// Records the master's grade for each line of grade-parity.json (T-312; arch 07 line 413). It loads the master's own
// lib.js and calls its grade() (lib.js line 483) on each line, then writes the numbers into the file as "master".
// grade.test.ts reads only the recorded numbers, so no test needs the master. Run it again only to add lines:
//   node actions/src/finalize/checks/grade-parity.record.mjs <the master's engine folder>
// The engine folder is the read-only copy, scratch/master-copy/engine (default: that path from the current folder).

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const table = path.join(path.dirname(fileURLToPath(import.meta.url)), "grade-parity.json");
const libFile = path.join(
  path.resolve(process.argv[2] ?? "scratch/master-copy/engine"),
  "work",
  "build",
  "lib.js",
);
const { grade } = createRequire(import.meta.url)(libFile);

const parity = JSON.parse(readFileSync(table, "utf8"));
for (const line of parity.lines) line.master = grade(line.text);
writeFileSync(table, `${JSON.stringify(parity, null, 2)}\n`);
console.log(`recorded the master's grade for ${parity.lines.length} lines, from ${libFile}`);
