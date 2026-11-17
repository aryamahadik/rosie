// T-1440 (T-1121's security reviewer, rounds 1 and 2; DL-927): the Linq live probe's own test,
// adapters/spikes/linq-live/probe.test.mjs (T-1121), fails on a key shape, an authorization header or an unmasked
// phone number in any recorded sample in adapters/spikes/linq-live/samples/. No Vitest project reaches it and the CI
// script tests' glob is infra/ci/*.test.mjs, so until T-1440 it ran only by hand. package.json's test:linq-probe runs
// it, and both workflows run that script as a step of its own: ci.yml's checks job on every push to main, and
// merge-check.yml's merge-check job in every merge check (the local merge-check runs that job's steps as the file
// holds them). It needs no network, database or key: each probe run in it is a dry run against its stand-in on
// 127.0.0.1, never --live.
//
// The workflows are read with the local merge-check's YAML reader, and merge-check.yml also with its workflow reader.
// The last test runs the same checks on changed copies of package.json and of both workflows and shows them fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseYaml, readWorkflow } from "./local-merge-check.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = "test:linq-probe";
const PROBE_TEST = "adapters/spikes/linq-live/probe.test.mjs";
const COMMAND = `node --test ${PROBE_TEST}`;
const STEP = `npm run ${SCRIPT}`;
const INSTALL = "npm ci --no-audit --no-fund";
// Each workflow with its job that runs every branch check.
const JOBS = { "ci.yml": "checks", "merge-check.yml": "merge-check" };
// A step's other keys could skip it (if), let its failure pass (continue-on-error), or change what, where or how long
// it runs (shell, working-directory, env, timeout-minutes, uses, with). The step has none of them.
const STEP_KEYS = ["name", "run"];

const read = (file) => readFileSync(path.join(REPO, file), "utf8");
const workflowText = (file) => read(`.github/workflows/${file}`);
const workflow = (file) => parseYaml(workflowText(file));
const manifest = () => JSON.parse(read("package.json"));

/** What keeps package.json's script from running the probe's test file, whole and alone: [] when nothing does. */
function scriptProblems(pkg) {
  const line = pkg.scripts?.[SCRIPT];
  if (line === undefined) return [`package.json has no ${SCRIPT} script`];
  if (line !== COMMAND) return [`${SCRIPT} runs ${JSON.stringify(line)}, not ${COMMAND}`];
  return [];
}

/** What keeps a job of a parsed workflow from running the script as a step of its own whenever the job runs. */
function stepProblems(doc, job) {
  const steps = doc.jobs?.[job]?.steps;
  if (!Array.isArray(steps)) return [`there is no job ${job} with steps`];
  const found = steps.flatMap((step, k) => (step.run === STEP ? [k] : []));
  if (found.length !== 1) return [`${found.length} steps of the ${job} job run ${STEP}, not 1`];
  const [at] = found;
  const step = steps[at];
  const problems = Object.keys(step)
    .filter((key) => !STEP_KEYS.includes(key))
    .map((key) => `its step has ${key}: ${JSON.stringify(step[key])}`);
  if (typeof step.name !== "string" || step.name.trim() === "") problems.push("its step has no name");
  const install = steps.findIndex((other) => other.run === INSTALL);
  if (install === -1 || install > at) problems.push(`its step does not come after ${INSTALL}`);
  return problems;
}

const theStep = (doc, job) => doc.jobs[job].steps.find((step) => step.run === STEP);

function withoutTheStep(doc, job) {
  const step = theStep(doc, job);
  doc.jobs[job].steps = doc.jobs[job].steps.filter((other) => other !== step);
  return step;
}

test("package.json's test:linq-probe runs the Linq probe's own test file, whole and alone", () => {
  assert.deepEqual(scriptProblems(manifest()), []);
  assert.ok(existsSync(path.join(REPO, PROBE_TEST)), `${PROBE_TEST} exists`);
});

for (const [file, job] of Object.entries(JOBS)) {
  test(`${file}'s ${job} job runs ${STEP} once, after npm ci, with nothing that could skip it or let it fail unseen`, () => {
    assert.deepEqual(stepProblems(workflow(file), job), []);
  });
}

test("the local merge-check, which runs the merge check on the build Mac, reads that step as a plain run step", () => {
  const job = readWorkflow(workflowText("merge-check.yml")).jobs.find((one) => one.id === "merge-check");
  assert.ok(job, "merge-check.yml has the merge-check job");
  const steps = job.steps.filter((step) => step.run?.trim() === STEP);
  assert.equal(steps.length, 1, `the merge-check job runs ${STEP} once`);
  assert.equal(steps[0].kind, "run");
  assert.equal(steps[0].if, null, "it runs whenever the steps before it passed");
  assert.deepEqual(steps[0].env, {});
});

test("the checks fail on copies of package.json and of both workflows that drop the step, skip it, let it fail or run something else", () => {
  const scriptCopies = [
    {
      name: "without the script",
      says: /^package\.json has no test:linq-probe script$/,
      change: (pkg) => {
        delete pkg.scripts["test:linq-probe"];
      },
    },
    {
      name: "with the script on another file",
      says: /, not node --test adapters\/spikes\/linq-live\/probe\.test\.mjs$/,
      change: (pkg) => {
        pkg.scripts[SCRIPT] = "node --test adapters/spikes/linq-live/lib.mjs";
      },
    },
    {
      name: "with the script's failure hidden",
      says: /, not node --test adapters\/spikes\/linq-live\/probe\.test\.mjs$/,
      change: (pkg) => {
        pkg.scripts[SCRIPT] = `${COMMAND} || true`;
      },
    },
    {
      name: "with some of the probe's tests alone",
      says: /, not node --test adapters\/spikes\/linq-live\/probe\.test\.mjs$/,
      change: (pkg) => {
        pkg.scripts[SCRIPT] = `node --test --test-name-pattern=masking ${PROBE_TEST}`;
      },
    },
  ];
  for (const { name, says, change } of scriptCopies) {
    const pkg = manifest();
    assert.deepEqual(scriptProblems(pkg), [], "package.json as it stands passes");
    change(pkg);
    const problems = scriptProblems(pkg);
    assert.ok(
      problems.some((problem) => says.test(problem)),
      `a copy of package.json ${name} fails: ${problems.join("; ")}`,
    );
  }

  const stepCopies = [
    {
      name: "without the step",
      says: /^0 steps of the [a-z-]+ job run npm run test:linq-probe, not 1$/,
      change: withoutTheStep,
    },
    {
      name: "with the step twice",
      says: /^2 steps of the [a-z-]+ job run npm run test:linq-probe, not 1$/,
      change: (doc, job) => {
        doc.jobs[job].steps.push({ ...theStep(doc, job) });
      },
    },
    {
      name: "with the step skipped",
      says: /^its step has if: "false"$/,
      change: (doc, job) => {
        theStep(doc, job).if = "false";
      },
    },
    {
      name: "with the step's failure let pass",
      says: /^its step has continue-on-error: true$/,
      change: (doc, job) => {
        theStep(doc, job)["continue-on-error"] = true;
      },
    },
    {
      name: "with the step's failure hidden",
      says: /^0 steps of the [a-z-]+ job run npm run test:linq-probe, not 1$/,
      change: (doc, job) => {
        theStep(doc, job).run = `${STEP} || true`;
      },
    },
    {
      name: "with the step run in another folder",
      says: /^its step has working-directory: "adapters"$/,
      change: (doc, job) => {
        theStep(doc, job)["working-directory"] = "adapters";
      },
    },
    {
      name: "with the step before npm ci",
      says: /^its step does not come after npm ci --no-audit --no-fund$/,
      change: (doc, job) => {
        const step = withoutTheStep(doc, job);
        doc.jobs[job].steps.unshift(step);
      },
    },
  ];
  for (const [file, job] of Object.entries(JOBS)) {
    for (const { name, says, change } of stepCopies) {
      const doc = workflow(file);
      assert.deepEqual(stepProblems(doc, job), [], `${file} as it stands passes`);
      change(doc, job);
      const problems = stepProblems(doc, job);
      assert.ok(
        problems.some((problem) => says.test(problem)),
        `a copy of ${file} ${name} fails: ${problems.join("; ")}`,
      );
    }
  }

  // merge-check.yml with the step moved to the parity shard job, which runs only when a parity input changed.
  const moved = workflow("merge-check.yml");
  const step = withoutTheStep(moved, "merge-check");
  moved.jobs["parity-shard"].steps.push(step);
  assert.deepEqual(stepProblems(moved, "merge-check"), [
    "0 steps of the merge-check job run npm run test:linq-probe, not 1",
  ]);
});
