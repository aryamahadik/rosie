// The 243 kinds of work the spike matches against (T-631), read the way the kinds seed reads them (db/seeds/kinds.ts,
// T-212): fixture set v1's trade files, fixtures/master/engine/work/prof/<id>.json, each checked against
// fixtures/master/SHA256SUMS (T-130) before it is parsed, then read by its top keys through T-133's loader
// (compiler/src/load/trade.ts parseTrade). Read only: nothing here writes a file or reaches a database.
//
// Each kind holds what K-24 v1's `kinds` row holds for the matcher (README line 41: name, style and pattern of the rows
// whose source is trade_file), and, for candidate B alone, two of the trade's 11 plug-in text blocks as K-01 v1's
// tradeOverlay.pluginText holds them (each the file's value as JSON text, read whole, never by a sub-key: MC R3):
//   pf.services   its services and prices ("They also cover its services and prices": A4-03, B4-04)
//   pf.questions  its questions for customers ("Its questions: where the clog or leak is": B4-04)
// pf.edges (work that is "too small, belongs elsewhere, or is done outside Rosie") names other kinds' work, so it is
// never read as a kind's own words.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTrade } from "../../../compiler/src/load/trade.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The repository's root. */
export const ROOT = resolve(HERE, "..", "..", "..");
/** T-130's vendored master inputs, the trade files fixture set v1 was made from (the kinds seed's TRADE_SET_DIR). */
export const TRADE_SET_DIR = join(ROOT, "fixtures", "master");
/** K-24 v1: a kind seeded from a trade file. The matcher offers only these (README "Open gaps"). */
export const KIND_SOURCE = "trade_file";
/** The plug-in text blocks candidate B reads (K-01 pluginText keys). */
export const TEXT_BLOCKS = ["pf.services", "pf.questions"];

const SUMS_FILE = "SHA256SUMS";
const TRADES_DIR = "engine/work/prof/";
const SUMS_LINE = /^([0-9a-f]{64}) {2}(\S.*)$/;
const TRADE_FILE = /^engine\/work\/prof\/([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/;

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Every trade file SHA256SUMS lists under engine/work/prof/, checked against its hash, parsed and loaded: one kind per
 * file, in code-point order of id. Throws, naming the file, on a changed file or a line it cannot read; nothing is
 * parsed before its bytes are checked.
 */
export function loadCatalog(dir = TRADE_SET_DIR) {
  const sums = readFileSync(join(dir, SUMS_FILE), "utf8");
  const kinds = [];
  for (const line of sums.split("\n")) {
    if (line === "") continue;
    const listed = SUMS_LINE.exec(line);
    if (listed === null) throw new Error(`${SUMS_FILE}: a line is not "<sha256>  <path>"`);
    const [, sha256, path] = listed;
    if (!path.startsWith(TRADES_DIR)) continue;
    const trade = TRADE_FILE.exec(path);
    if (trade === null) throw new Error(`${SUMS_FILE} lists ${path}, which is not a trade file's name`);
    const id = trade[1];
    const bytes = readFileSync(join(dir, ...path.split("/")));
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
      throw new Error(`${path} does not match ${SUMS_FILE}, so it was not read`);
    }
    const loaded = parseTrade(JSON.parse(bytes.toString("utf8")), id);
    kinds.push({
      id,
      name: loaded.name,
      style: loaded.style,
      pattern: loaded.pattern,
      source: KIND_SOURCE,
      blocks: Object.fromEntries(TEXT_BLOCKS.map((key) => [key, loaded.pluginText[key]])),
    });
  }
  if (kinds.length === 0) throw new Error(`${SUMS_FILE} lists no trade file under ${TRADES_DIR}`);
  return kinds.sort(byId);
}
