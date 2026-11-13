// Tests for K-02's named rules, the fixture check's named-rule hook, and K-02 v1's freeze (T-011). Run by
// `npm run contracts:check`. Nothing in contracts/ is changed: each test that edits works on a throwaway copy, or a
// throwaway git repository, in the system temp folder.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { optionOffered, quoteInText, rules } from "../model/model.rules.mjs";
import { checkContracts } from "./check-fixtures.mjs";
import { CONTRACTS_DIR, createAjv, idFor, readJson } from "./lib.mjs";

const GUARD = fileURLToPath(new URL("../../infra/ci/contract-freeze-guard.mjs", import.meta.url));
const MODEL = path.join(CONTRACTS_DIR, "model");
const fixture = (file) => readJson(path.join(MODEL, "fixtures", file));
const clone = (value) => structuredClone(value);

function tempDir(t, label) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `rosie-model-${label}-`)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A validator for one $defs entry of model.v1, with the shared formats and the bundle loaded. */
function validatorFor(def) {
  const ajv = createAjv();
  for (const file of [
    "common/formats.v1.schema.json",
    "bundle/bundle.v1.schema.json",
    "model/model.v1.schema.json",
  ]) {
    ajv.addSchema(readJson(path.join(CONTRACTS_DIR, file)));
  }
  return ajv.getSchema(`${idFor("model/model.v1.schema.json")}#/$defs/${def}`);
}

const pairS102 = () => ({
  context: fixture("context-s1-02.json"),
  decide: fixture("decide-s1-02-choose.json"),
});
const pairTwo = () => ({
  context: fixture("context-two-requests.json"),
  decide: fixture("decide-two-requests.json"),
});

describe("K-02 named rules (model.rules.mjs)", () => {
  it("exports exactly the rules the index names", () => {
    assert.deepEqual(Object.keys(rules).sort(), ["optionOffered", "quoteInText"]);
    const named = fixture("index.json")
      .fixtures.filter((entry) => entry.rule !== undefined)
      .map((entry) => entry.rule)
      .sort();
    assert.deepEqual(named, ["optionOffered", "quoteInText"]);
  });

  it("passes the accepted contexts with the decide results made from them", () => {
    for (const pair of [pairS102(), pairTwo()]) {
      assert.ok(validatorFor("contextAndDecide")(pair));
      assert.deepEqual(optionOffered(pair), []);
      assert.deepEqual(quoteInText(pair), []);
    }
  });

  it("refuses refuse-option-not-offered for that rule alone, and passes it once the choice is offered", () => {
    const pair = fixture("invalid/refuse-option-not-offered.json");
    assert.ok(validatorFor("contextAndDecide")(pair), "the schema takes it");
    assert.deepEqual(quoteInText(pair), []);
    const problems = optionOffered(pair);
    assert.ok(problems.length > 0);
    for (const line of problems) assert.match(line, /chooses c-99, which the context's choices do not hold/);
    const fixed = clone(pair);
    for (const read of fixed.decide.reads) read.output.parts[0].choice = "c-01";
    fixed.decide.parts[0].part.choice = "c-01";
    assert.deepEqual(optionOffered(fixed), []);
  });

  it("refuses refuse-quote-not-in-text for that rule alone, and passes it once the quote is the text's", () => {
    const pair = fixture("invalid/refuse-quote-not-in-text.json");
    assert.ok(validatorFor("contextAndDecide")(pair), "the schema takes it");
    assert.deepEqual(optionOffered(pair), []);
    const problems = quoteInText(pair);
    assert.ok(problems.length > 0);
    for (const line of problems)
      assert.match(line, /the quote "Barbershop and plumbing" is not in the turn's texts/);
    const fixed = clone(pair);
    for (const read of fixed.decide.reads) read.output.parts[0].quote = "Barbershop, plumbing, electrical";
    fixed.decide.parts[0].part.quote = "Barbershop, plumbing, electrical";
    assert.deepEqual(quoteInText(fixed), []);
  });

  it("optionOffered: the verb must fit the choice's kind, choose names its question, fields are the choice's", () => {
    const enterOption = pairS102();
    enterOption.decide.parts[0].part = { verb: "enter", quote: "Barbershop", choice: "c-01", fields: [] };
    assert.match(
      optionOffered(enterOption).join("\n"),
      /enter takes door, anytime, searchEntry, but c-01 is option/,
    );

    const chooseDoor = pairS102();
    chooseDoor.decide.parts[0].part = {
      verb: "choose",
      quote: "Barbershop",
      question: "oq-s1-02",
      choice: "c-04",
      fields: [],
    };
    assert.match(
      optionOffered(chooseDoor).join("\n"),
      /choose takes option, hub, whichBooking, but c-04 is door/,
    );

    const wrongQuestion = pairS102();
    wrongQuestion.decide.parts[0].part.question = "oq-other";
    assert.match(
      optionOffered(wrongQuestion).join("\n"),
      /names the question oq-other, but c-01 answers oq-s1-02/,
    );

    const strayField = pairS102();
    strayField.decide.parts[0].part.fields.push({ name: "price", value: 1, words: "Barbershop" });
    assert.match(optionOffered(strayField).join("\n"), /the field price is not one c-01 carries/);

    const askElsewhere = pairS102();
    askElsewhere.decide.parts[0].part = {
      verb: "ask",
      quote: "Barbershop",
      questions: ["oq-gone"],
      unclear: "x",
    };
    assert.match(
      optionOffered(askElsewhere).join("\n"),
      /asks about oq-gone, which no offered choice answers/,
    );

    const twice = pairS102();
    twice.context.choices.push(clone(twice.context.choices[0]));
    assert.match(optionOffered(twice).join("\n"), /the choice id c-01 appears twice/);
  });

  it("quoteInText: field words and pass_on or redact words must be in the texts too", () => {
    const fieldWords = pairTwo();
    fieldWords.decide.reads[1].output.parts[1].fields[1].words = "$13 a foot";
    assert.match(
      quoteInText(fieldWords).join("\n"),
      /reads\[1\]\.output\.parts\[1\]: the words "\$13 a foot" of the field price are not in the turn's texts/,
    );
    const passOn = pairS102();
    passOn.decide.parts[0].part = { verb: "pass_on", quote: "Barbershop", words: "Plumbing only" };
    assert.match(quoteInText(passOn).join("\n"), /the words "Plumbing only" are not in the turn's texts/);
  });
});

describe("K-02 refused fixtures are refused for the one reason they show", () => {
  it("each schema-refused fixture is accepted after its one fault is fixed", () => {
    const decideRead = validatorFor("decideRead");
    const planner = validatorFor("plannerOutput");
    const context = validatorFor("context");

    const unknownVerb = fixture("invalid/refuse-unknown-verb.json");
    assert.equal(decideRead(unknownVerb), false);
    unknownVerb.parts[0].verb = "choose";
    assert.ok(decideRead(unknownVerb), JSON.stringify(decideRead.errors));

    const noWords = fixture("invalid/refuse-value-without-words.json");
    assert.equal(decideRead(noWords), false);
    noWords.parts[0].fields[0].words = "Saturday at 2";
    assert.ok(decideRead(noWords), JSON.stringify(decideRead.errors));

    const books = fixture("invalid/refuse-planner-books.json");
    assert.equal(planner(books), false);
    books.action.verb = "answer";
    assert.ok(planner(books), JSON.stringify(planner.errors));

    const over60 = fixture("invalid/refuse-over-60-choices.json");
    assert.equal(over60.choices.length, 61);
    assert.equal(context(over60), false);
    over60.choices.pop();
    assert.ok(context(over60), JSON.stringify(context.errors));
  });

  it("a high-stakes choice needs a reason, and a low one has none", () => {
    const context = validatorFor("context");
    const high = fixture("context-s1-02.json");
    high.choices[0].stakes = "high";
    assert.equal(context(high), false);
    high.choices[0].stakesFrom = [{ why: "calendarWrite", step: "A7-19", ref: "calendar" }];
    assert.ok(context(high), JSON.stringify(context.errors));
    high.choices[0].stakes = "low";
    assert.equal(context(high), false);
  });

  it("a choice fills only the fields its kind uses, and a safety timeout has no read", () => {
    const context = validatorFor("context");
    const door = fixture("context-s1-02.json");
    door.choices[3].question = "oq-s1-02";
    assert.equal(context(door), false, "a door takes no question");
    const safety = validatorFor("safetyResult");
    const timeout = fixture("safety-timeout-danger-word.json");
    timeout.read = { labels: [{ outcome: "No", tense: "now", evidence: "", atRisk: "nobody", writer: "x" }] };
    assert.equal(safety(timeout), false);
    const reread = validatorFor("decideResult");
    const disagree = fixture("decide-reads-disagree.json");
    disagree.reads.pop();
    assert.equal(reread(disagree), false, "a re-read is the third read");
  });

  it("a matched danger word names its kind, and a hand-off whom it is about, from closed lists", () => {
    const safety = validatorFor("safetyResult");
    const timeout = fixture("safety-timeout-self-harm-word.json");
    assert.ok(safety(timeout), JSON.stringify(safety.errors));
    delete timeout.dangerWords[0].kind;
    assert.equal(safety(timeout), false, "kind is required");
    timeout.dangerWords[0].kind = "crisis";
    assert.equal(safety(timeout), false, "kind is selfHarm or other");

    const planner = validatorFor("plannerOutput");
    const handOff = fixture("planner-hand-off.json");
    assert.ok(planner(handOff), JSON.stringify(planner.errors));
    delete handOff.action.about;
    assert.equal(planner(handOff), false, "about is required");

    const decideRead = validatorFor("decideRead");
    const read = fixture("decide-hand-off-owner-or-staff.json").reads[0].output;
    assert.ok(decideRead(read), JSON.stringify(decideRead.errors));
    read.parts[0].about = "Riley";
    assert.equal(decideRead(read), false, "about is ownerOrStaff or other");
  });
});

/** A copy of what the fixture check reads, with a contract "widget" that has one named rule. */
function widgetCopy(t, { rulesFile = true, entries } = {}) {
  const dir = tempDir(t, "rules");
  for (const part of ["common", "db-schema/tables.meta.schema.json"]) {
    cpSync(path.join(CONTRACTS_DIR, part), path.join(dir, part), { recursive: true });
  }
  const write = (file, data) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(
      path.join(dir, file),
      typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`,
    );
  };
  write("widget/widget.v1.schema.json", {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: idFor("widget/widget.v1.schema.json"),
    type: "object",
    properties: { a: { type: "integer" }, b: { type: "integer" } },
    required: ["a", "b"],
    additionalProperties: false,
  });
  if (rulesFile) {
    write(
      "widget/widget.rules.mjs",
      "export const rules = { sumIsTen: (p) => (p.a + p.b === 10 ? [] : [`a + b is ${p.a + p.b}, not 10`]) };\n",
    );
  }
  write("widget/fixtures/ten.json", { a: 4, b: 6 });
  write("widget/fixtures/nine.json", { a: 4, b: 5 });
  write("widget/fixtures/text.json", { a: "4", b: 6 });
  const entry = (file, expect, extra = {}) => ({
    file,
    version: "v1",
    expect,
    shows: file,
    source: "T-011 test",
    ...extra,
  });
  write("widget/fixtures/index.json", {
    fixtures: entries?.(entry) ?? [
      entry("ten.json", "accept", { rule: "sumIsTen" }),
      entry("nine.json", "refuse", { rule: "sumIsTen" }),
      entry("text.json", "refuse"),
    ],
  });
  return { dir, check: () => checkContracts(dir) };
}

describe("the fixture check's named-rule hook (check-fixtures.mjs)", () => {
  it("accepts a fixture that passes its rule and refuses one its rule fails, after the schema takes both", (t) => {
    const { errors, counts } = widgetCopy(t).check();
    assert.deepEqual(errors, []);
    assert.equal(counts.refusedByRule, 1);
    assert.ok(counts.refused >= 2, JSON.stringify(counts)); // the widget's two, and common/'s own
  });

  it("fails a refused fixture that its rule passes, and an accepted one that its rule refuses", (t) => {
    const copy = widgetCopy(t, {
      entries: (entry) => [
        entry("ten.json", "refuse", { rule: "sumIsTen" }),
        entry("nine.json", "accept", { rule: "sumIsTen" }),
        entry("text.json", "refuse"),
      ],
    });
    const text = copy.check().errors.join("\n");
    assert.match(
      text,
      /ten\.json: must be refused by the rule sumIsTen \(it shows: ten\.json\), but the rule passes it/,
    );
    assert.match(text, /nine\.json: must pass the rule sumIsTen, but:\n {2}a \+ b is 9, not 10/);
  });

  it("fails a ruled fixture its schema refuses: a rule never stands in for the schema", (t) => {
    const copy = widgetCopy(t, {
      entries: (entry) => [
        entry("ten.json", "accept"),
        entry("nine.json", "refuse", { rule: "sumIsTen" }),
        entry("text.json", "refuse", { rule: "sumIsTen" }),
      ],
    });
    assert.match(
      copy.check().errors.join("\n"),
      /text\.json: names the rule sumIsTen, so widget\.v1\.schema\.json must accept it and the rule alone decide it, but the schema refuses it/,
    );
  });

  it("fails a rule the rules file does not export, and a contract with no rules file", (t) => {
    const unknown = widgetCopy(t, {
      entries: (entry) => [
        entry("ten.json", "accept"),
        entry("nine.json", "refuse", { rule: "sumIsNine" }),
        entry("text.json", "refuse"),
      ],
    });
    assert.match(
      unknown.check().errors.join("\n"),
      /nine\.json: names the rule sumIsNine, which widget\/widget\.rules\.mjs does not export/,
    );
    const missing = widgetCopy(t, { rulesFile: false });
    assert.match(
      missing.check().errors.join("\n"),
      /names the rule sumIsTen, which widget\/widget\.rules\.mjs does not exist/,
    );
  });

  it("the fixtures-index meta-schema takes a rule name, but not with a table or in another spelling", () => {
    const meta = createAjv().compile(
      readJson(path.join(CONTRACTS_DIR, "common/fixtures-index.meta.schema.json")),
    );
    const entry = { file: "a.json", version: "v1", expect: "refuse", shows: "x", source: "x" };
    assert.ok(meta({ fixtures: [{ ...entry, rule: "optionOffered" }] }));
    assert.equal(meta({ fixtures: [{ ...entry, rule: "option-offered" }] }), false);
    assert.equal(meta({ fixtures: [{ ...entry, rule: "optionOffered", table: "turns" }] }), false);
  });
});

// The frozen-contract guard of T-005 (infra/ci/contract-freeze-guard.mjs), run on K-02 as it is on this branch, in a
// throwaway git repository whose fake origin/main already holds contracts/model with its frozen.json.
describe("K-02 v1 is frozen: the frozen-contract guard fails an edit", () => {
  function gitEnvironment(dir) {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith("GIT_") && !key.startsWith("GITHUB_")) env[key] = value;
    }
    return {
      ...env,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CEILING_DIRECTORIES: path.dirname(dir),
      GIT_AUTHOR_NAME: "Contract Test",
      GIT_AUTHOR_EMAIL: "contract-test@example.invalid",
      GIT_COMMITTER_NAME: "Contract Test",
      GIT_COMMITTER_EMAIL: "contract-test@example.invalid",
    };
  }

  function modelRepo(t) {
    const dir = tempDir(t, "guard");
    const env = gitEnvironment(dir);
    const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: "pipe" });
    git("init", "-q", "-b", "main");
    cpSync(MODEL, path.join(dir, "contracts/model"), { recursive: true });
    git("add", "-A");
    git("commit", "-q", "-m", "base: K-02 v1 frozen");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("switch", "-q", "-c", "task/T-999");
    const at = (file) => path.join(dir, "contracts/model", file);
    return {
      edit(file, change) {
        const before = readFileSync(at(file), "utf8");
        const after = change(before);
        assert.notEqual(after, before, `the test's edit to ${file} changed nothing`);
        writeFileSync(at(file), after);
      },
      add(file, text) {
        mkdirSync(path.dirname(at(file)), { recursive: true });
        writeFileSync(at(file), text);
      },
      guard: () => spawnSync(process.execPath, [GUARD], { cwd: dir, env, encoding: "utf8" }),
    };
  }

  it("contracts/model/frozen.json freezes v1, v1.1 and v1.2", () => {
    assert.deepEqual(readJson(path.join(MODEL, "frozen.json")), { frozen: ["v1", "v1.1", "v1.2"] });
  });

  it("fails an edit to model.v1.schema.json", (t) => {
    const repo = modelRepo(t);
    repo.edit("model.v1.schema.json", (text) =>
      text.replace('"enum": ["high", "low"]', '"enum": ["high", "medium", "low"]'),
    );
    const run = repo.guard();
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /contracts\/model\/model\.v1\.schema\.json: edits a file of v1/);
  });

  it("fails an edit to an accepted fixture, a refused fixture, or an index entry", (t) => {
    const repo = modelRepo(t);
    repo.edit("fixtures/decide-bare-2.json", (text) => text.replace('"quote": "2"', '"quote": "3"'));
    repo.edit("fixtures/invalid/refuse-over-60-choices.json", (text) => text.replace('"c-61"', '"c-62"'));
    repo.edit("fixtures/index.json", (text) =>
      text.replace('"rule": "quoteInText"', '"rule": "optionOffered"'),
    );
    const run = repo.guard();
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /decide-bare-2\.json: edits a fixture of v1/);
    assert.match(run.stdout, /refuse-over-60-choices\.json: edits a fixture of v1/);
    assert.match(
      run.stdout,
      /fixtures\/index\.json: the index entry for .*refuse-quote-not-in-text\.json \(v1, frozen\) changes/,
    );
  });

  it("passes adding a minor version and its fixtures beside the frozen v1, v1.1 and v1.2", (t) => {
    const repo = modelRepo(t);
    repo.add("model.v1.3.schema.json", "{}\n");
    repo.add("fixtures/read-price-list.json", "{}\n");
    const run = repo.guard();
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });
});
