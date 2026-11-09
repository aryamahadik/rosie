// T-1119 (STATE note 64, DL-234): ci.yml's checks job runs node --test "infra/ci/*.test.mjs", and the run tests
// of local-merge-check.test.mjs (T-1111) in it make and drop databases on a PostgreSQL server. So the job has
// merge-check.yml's postgis service (the same image, port, health check and database) and that step gets
// merge-check.yml's DATABASE_URL, which reaches the service. Both files are read with the local merge-check's own
// YAML reader (parseYaml refuses, with its line number, anything it cannot read), so a ci.yml that does not parse
// fails here. The last test runs the same checks on changed copies of ci.yml and shows them fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseYaml } from "./local-merge-check.mjs";

const STEP = 'node --test "infra/ci/*.test.mjs"';

function workflow(name) {
  const file = fileURLToPath(new URL(`../../.github/workflows/${name}`, import.meta.url));
  return parseYaml(readFileSync(file, "utf8"));
}

// merge-check.yml's merge-check job: its postgres service and its DATABASE_URL, the model ci.yml copies.
function model() {
  const job = workflow("merge-check.yml").jobs["merge-check"];
  const service = job.services?.postgres;
  assert.ok(service, "merge-check.yml's merge-check job has a postgres service");
  assert.match(service.image, /^postgis\/postgis:/, "its image is postgis/postgis");
  assert.match(service.options, /--health-cmd "pg_isready /, "it has a pg_isready health check");
  assert.ok(Array.isArray(service.ports) && service.ports.length > 0, "it publishes a port");
  assert.match(job.env?.DATABASE_URL ?? "", /^postgres:\/\//, "the job sets a DATABASE_URL");
  return { service, url: job.env.DATABASE_URL };
}

// The checks job's step that runs the CI script tests, with the env it runs with (workflow's, job's, step's).
function scriptStep(doc) {
  const job = doc.jobs.checks;
  const steps = job.steps.filter((step) => step.run === STEP);
  assert.equal(steps.length, 1, `the checks job runs ${STEP} in one step`);
  return { step: steps[0], env: { ...doc.env, ...job.env, ...steps[0].env } };
}

// A parsed ci.yml's checks job has the model's postgres service, whole.
function assertService(doc, { service }) {
  const own = doc.jobs.checks.services?.postgres;
  assert.ok(own, "the checks job has a postgres service");
  assert.equal(own.image, service.image, "merge-check.yml's image");
  assert.deepEqual(own.ports, service.ports, "merge-check.yml's port");
  assert.equal(own.options, service.options, "merge-check.yml's health check");
  assert.deepEqual(own.env, service.env, "merge-check.yml's user, password and database");
  assert.deepEqual(own, service, "merge-check.yml's service, with nothing added or left out");
}

// Its CI script tests step gets the model's DATABASE_URL, and that URL reaches the job's postgres service.
function assertDatabaseUrl(doc, { url }) {
  const { env } = scriptStep(doc);
  assert.equal(env.DATABASE_URL, url, `the ${STEP} step gets merge-check.yml's DATABASE_URL`);
  const own = doc.jobs.checks.services?.postgres;
  assert.ok(own, "the checks job has a postgres service for the DATABASE_URL to reach");
  const target = new URL(env.DATABASE_URL);
  const published = own.ports.map((mapping) => String(mapping).split(":")[0]);
  assert.ok(["localhost", "127.0.0.1"].includes(target.hostname), "the service's port is on the runner");
  const port = target.port || "5432";
  assert.ok(published.includes(port), `port ${port} is the service's published port (${published})`);
  assert.equal(target.username, own.env.POSTGRES_USER, "the service's user");
  assert.equal(target.password, own.env.POSTGRES_PASSWORD, "the service's password");
  assert.equal(target.pathname, `/${own.env.POSTGRES_DB}`, "the service's database");
}

function assertDatabase(doc, db) {
  assertService(doc, db);
  assertDatabaseUrl(doc, db);
}

test("ci.yml parses with the local merge-check's YAML reader, and its one job runs the CI script tests once", () => {
  const doc = workflow("ci.yml");
  assert.deepEqual(Object.keys(doc.jobs), ["checks"]);
  assert.ok(Array.isArray(doc.jobs.checks.steps), "the checks job has steps");
  scriptStep(doc);
});

test("ci.yml's checks job has merge-check.yml's postgres service: its image, port, health check and database", () => {
  assertService(workflow("ci.yml"), model());
});

test("ci.yml gives its CI script tests step merge-check.yml's DATABASE_URL, which reaches that service", () => {
  assertDatabaseUrl(workflow("ci.yml"), model());
});

test("the checks fail on copies of ci.yml without the service or the DATABASE_URL, or with either changed", () => {
  const db = model();
  const service = (doc) => doc.jobs.checks.services.postgres;
  const changes = {
    "without the service": (doc) => {
      delete doc.jobs.checks.services;
    },
    "with another image": (doc) => {
      service(doc).image = "postgis/postgis:16-3.4";
    },
    "without the health check": (doc) => {
      service(doc).options = service(doc).options.replace(/--health-cmd "[^"]*"\s*/, "");
    },
    "with another port": (doc) => {
      service(doc).ports = ["5433:5432"];
    },
    "without the DATABASE_URL": (doc) => {
      delete doc.env?.DATABASE_URL;
      delete doc.jobs.checks.env?.DATABASE_URL;
      delete scriptStep(doc).step.env?.DATABASE_URL;
    },
    "with the DATABASE_URL on another database": (doc) => {
      const { step } = scriptStep(doc);
      step.env = { ...step.env, DATABASE_URL: "postgres://rosie:rosie@localhost:5432/other" };
    },
  };
  for (const [name, change] of Object.entries(changes)) {
    const doc = workflow("ci.yml");
    assertDatabase(doc, db);
    change(doc);
    assert.throws(() => assertDatabase(doc, db), assert.AssertionError, `a copy ${name} fails`);
  }
});
