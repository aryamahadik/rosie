// The outbound Linq probe's Node half (T-1121). Run it through probe.sh, which reads the values by name and hands them
// over on standard input, one a line; this program takes no value from its arguments or its environment. The run itself
// is lib.mjs's runProbe.

import { runProbe } from "./lib.mjs";

process.exitCode = await runProbe({
  argv: process.argv.slice(2),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
