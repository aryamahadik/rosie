// The Workers test rig's globalSetup (T-1253; ADR-014 section 4's piece 5), for both Workers projects of vitest.config.ts
// (the e2e-workers project keeps its own globalSetup beside it). It runs in Node before any test file of the run:
// startRig (rig.mjs) refuses any server but a local or CI one, then makes the run's template and each named file's
// database (files.mjs) and the logins, and this provides the pool's Hyperdrive bindings and the files' database names
// (rig.mjs PROVIDED; provided.d.ts types them), which vitest.config.ts's pool function and the tests read through inject.
// At teardown, which Vitest runs after a failed test too, stop() drops the databases the run made, and only those.
import { PROVIDED, startRig } from "./rig.mjs";

/** @param {import("vitest/node").TestProject} project */
export default async function setup(project) {
  const rig = await startRig({ log: (line) => console.log(line) });
  project.provide(PROVIDED.hyperdrives, rig.hyperdrives);
  project.provide(PROVIDED.databases, rig.databases);
  return async () => {
    await rig.stop();
  };
}
