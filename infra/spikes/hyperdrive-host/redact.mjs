// Spike T-1124: copies stdin to stdout with one secret removed. run.sh passes wrangler's output through it before
// showing any of it: the secret (a database URL, or the run's probe token) arrives in the environment variable
// PROBE_REDACT, never as an argument, and a URL's password, user and host are removed on their own as well.
import { makeRedactor } from "./probe.mjs";

const redact = makeRedactor([process.env.PROBE_REDACT ?? ""]);
let text = "";
for await (const chunk of process.stdin) {
  text += String(chunk);
}
process.stdout.write(redact(text));
