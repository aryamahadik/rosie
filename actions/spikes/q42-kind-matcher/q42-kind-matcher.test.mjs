// The kind matcher spike's own tests (T-631): `node --test actions/spikes/q42-kind-matcher/q42-kind-matcher.test.mjs`.
// No Vitest project includes this folder, so CI runs none of it. They hold the catalog to the kinds seed's source and to
// K-24 v1's sample seed, the words rules and the outcome rule to what FINDINGS.md says of them, and FINDINGS.md's
// tables to the comparison as compare.mjs computes it, cell by cell, so the report cannot drift from the code.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { KIND_SOURCE, loadCatalog, ROOT, TEXT_BLOCKS } from "./catalog.mjs";
import {
  catalogLines,
  compare,
  HIT_HEADER,
  hitRows,
  measureCost,
  RATIO_HEADER,
  ratioRows,
  SAMPLE_HEADER,
  sampleRows,
  SHORTLIST_HEADER,
  shortlistRows,
} from "./compare.mjs";
import { buildTable, CANDIDATES, decide, FLOOR, matchKinds, rank, RATIO } from "./matchers.mjs";
import { GROUPS, SAMPLES } from "./samples.mjs";
import { fold, meets, splitParts, words } from "./words.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const catalog = loadCatalog();
const results = compare(catalog);

test("the catalog is the 243 trade-file kinds, each with its name, style, pattern and the two text blocks", () => {
  assert.equal(catalog.length, 243);
  assert.equal(new Set(catalog.map((kind) => kind.id)).size, 243);
  for (const kind of catalog) {
    assert.equal(kind.source, KIND_SOURCE);
    for (const field of [kind.name, kind.style, kind.pattern]) assert.ok(field.length > 0, kind.id);
    for (const key of TEXT_BLOCKS) assert.ok(kind.blocks[key].length > 0, `${kind.id} ${key}`);
  }
});

test("the catalog's names, styles and patterns are the ones K-24 v1's seed-kinds-sample.json seeds", () => {
  const fixture = JSON.parse(
    readFileSync(join(ROOT, "contracts/db-schema/kinds-of-work/fixtures/seed-kinds-sample.json"), "utf8"),
  );
  const seeded = fixture.rows.filter((row) => row.table === "kinds" && row.values.source === KIND_SOURCE);
  assert.equal(seeded.length, 8);
  for (const { values } of seeded) {
    const kind = catalog.find((each) => each.id === values.id);
    assert.ok(kind, values.id);
    assert.deepEqual([kind.name, kind.style, kind.pattern], [values.name, values.style, values.pattern]);
  }
});

test("a trade file that does not match SHA256SUMS is refused before it is parsed", () => {
  const dir = mkdtempSync(join(tmpdir(), "q42-catalog-"));
  try {
    mkdirSync(join(dir, "engine/work/prof"), { recursive: true });
    const bytes = readFileSync(join(ROOT, "fixtures/master/engine/work/prof/barber.json"));
    writeFileSync(join(dir, "engine/work/prof/barber.json"), bytes);
    const right = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(dir, "SHA256SUMS"), `${right}  engine/work/prof/barber.json\n`);
    assert.deepEqual(
      loadCatalog(dir).map((kind) => kind.id),
      ["barber"],
    );
    writeFileSync(join(dir, "SHA256SUMS"), `${"0".repeat(64)}  engine/work/prof/barber.json\n`);
    assert.throws(() => loadCatalog(dir), /does not match SHA256SUMS/);
    writeFileSync(join(dir, "SHA256SUMS"), `${right}  engine/work/prof/Barber.json\n`);
    assert.throws(() => loadCatalog(dir), /not a trade file's name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("words: lower case, possessives and function words dropped, plurals folded", () => {
  assert.deepEqual(words("Lee's Barbershop: plumbing & electrical, 2 barbers!"), [
    "lee",
    "barbershop",
    "plumbing",
    "electrical",
    "barber",
  ]);
  assert.equal(fold("plumbers"), "plumber");
  assert.equal(fold("services"), "service");
  assert.equal(fold("batteries"), "battery");
  assert.equal(fold("brushes"), "brush");
  assert.equal(fold("glass"), "glass");
});

test("meets: the same word 1; one starting the other, or a shared start of 5, by its share of the longer word", () => {
  assert.equal(meets("plumber", "plumber"), 1);
  assert.equal(meets("barbershop", "barber"), 6 / 10);
  assert.equal(meets("haircut", "hair"), 4 / 7);
  assert.equal(meets("plumbing", "plumber"), 5 / 8);
  assert.ok(meets("electrical", "electrician") > meets("electrical", "electronics"));
  assert.equal(meets("cut", "cutting"), 0);
  assert.equal(meets("water", "watch"), 0);
  assert.equal(meets("lawn", "lawyer"), 0);
});

test("splitParts: S1-02's answer is three parts; 'and' is not a split", () => {
  assert.deepEqual(splitParts("Barbershop, plumbing, electrical"), ["Barbershop", "plumbing", "electrical"]);
  assert.deepEqual(splitParts(" Pet boarding and doggy daycare ;\n"), ["Pet boarding and doggy daycare"]);
});

test("decide: none below the floor, 'which' with two when the second is close, else listed with one", () => {
  const kind = (id, score) => ({ id, name: id, score });
  assert.deepEqual(decide([]), { outcome: "none", kinds: [] });
  assert.deepEqual(decide([kind("a", FLOOR - 0.01)]), { outcome: "none", kinds: [] });
  assert.deepEqual(decide([kind("a", 10), kind("b", 10 * RATIO), kind("c", 10 * RATIO)]), {
    outcome: "which",
    kinds: ["a", "b"],
  });
  assert.deepEqual(decide([kind("a", 10), kind("b", 10 * RATIO - 0.01)]), {
    outcome: "listed",
    kinds: ["a"],
  });
});

test("A and A0 read K-24's columns alone; B reads the two text blocks too", () => {
  const blank = catalog.map((kind) => ({ ...kind, blocks: { "pf.services": "", "pf.questions": "" } }));
  for (const key of ["A0", "A"]) {
    assert.deepEqual(
      rank(buildTable(blank, CANDIDATES[key].fields), "water heater flush"),
      rank(buildTable(catalog, CANDIDATES[key].fields), "water heater flush"),
    );
  }
  assert.notDeepEqual(
    rank(buildTable(blank, CANDIDATES.B.fields), "water heater flush"),
    rank(buildTable(catalog, CANDIDATES.B.fields), "water heater flush"),
  );
});

test("A matches S1-02's answer to the three kinds K-24's seed-business-kinds.json picks, in order", () => {
  const table = buildTable(catalog, CANDIDATES.A.fields);
  assert.deepEqual(
    matchKinds(table, "Barbershop, plumbing, electrical").map(({ words: part, outcome, kinds }) => [
      part,
      outcome,
      kinds,
    ]),
    [
      ["Barbershop", "listed", ["barber"]],
      ["plumbing", "listed", ["plumber"]],
      ["electrical", "listed", ["electrician"]],
    ],
  );
});

test("every sample names catalog kinds (at most two), a known group and a source, and no number", () => {
  const ids = new Set(catalog.map((kind) => kind.id));
  for (const sample of SAMPLES) {
    assert.ok(GROUPS.includes(sample.group), sample.words);
    assert.ok(sample.fits.length <= 2, sample.words);
    for (const id of sample.fits) assert.ok(ids.has(id), `${sample.words}: ${id}`);
    assert.ok(sample.source.length > 0, sample.words);
    assert.doesNotMatch(sample.words, /\d{3}/, "no phone number or other long number (rule 9)");
  }
});

/** FINDINGS.md's text. The spike's builder could not write it (the harness refused), so the lead writes it. */
function findingsText() {
  const file = join(HERE, "FINDINGS.md");
  assert.ok(existsSync(file), "FINDINGS.md is missing: the lead writes it from the builder's findings_text");
  return readFileSync(file, "utf8");
}

/** The rows of the markdown table that follows `marker` in FINDINGS.md, each cell trimmed (alignment ignored). */
function findingsTable(marker) {
  const text = findingsText();
  const start = text.indexOf(`<!-- ${marker} -->`);
  assert.notEqual(start, -1, `FINDINGS.md has no <!-- ${marker} --> table`);
  const lines = text.slice(start).split("\n").slice(1);
  const rows = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (rows.length > 0) break;
      continue;
    }
    if (!line.startsWith("|")) break;
    rows.push(
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
  }
  return [rows[0], ...rows.slice(2)];
}

test("FINDINGS.md's tables are the comparison as compare.mjs computes it", () => {
  assert.deepEqual(findingsTable("hit-rates"), [HIT_HEADER, ...hitRows(results)]);
  assert.deepEqual(findingsTable("per-sample"), [SAMPLE_HEADER, ...sampleRows(results)]);
  assert.deepEqual(findingsTable("shortlists"), [SHORTLIST_HEADER, ...shortlistRows(results)]);
  assert.deepEqual(findingsTable("ratios"), [RATIO_HEADER, ...ratioRows(catalog)]);
});

test("FINDINGS.md states the catalog's size as a model read would carry it", () => {
  const text = findingsText();
  const characters = catalogLines(catalog).length.toLocaleString("en-US");
  assert.ok(text.includes(`${characters} characters`), `FINDINGS.md names ${characters} characters`);
});

test("the cost measure runs every candidate and reports its table and a match time", () => {
  const costs = measureCost(catalog, 1);
  assert.deepEqual(
    costs.map((cost) => cost.key),
    Object.keys(CANDIDATES),
  );
  for (const cost of costs) {
    assert.ok(cost.words > 0 && cost.bytes > 0 && cost.matchP50Us >= 0 && cost.buildMs >= 0, cost.key);
    assert.equal(cost.matches, SAMPLES.length);
  }
});
