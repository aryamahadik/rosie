// Records the master's common words into common-words.json (T-312; arch 07 line 409). The Values check reads a
// capitalized word that starts a line or a sentence as a possible name of a person or business, unless it is a code
// fact, a word of the step's master line or of a fixed line, or one of these: a word the master writes in lower case
// somewhere in Rosie's own message lines. The master writes every name in them capitalized (SPEC-master section 6:
// Sam, Riley, Avery, Jordan...), so no name is recorded, while "Your", "Thanks" or "Please" starting a sentence read
// as plain words. Only Rosie's lines count: a person's sample text may write a name in lower case ("sort out ben pls"),
// and so may a quote of one inside Rosie's line, so quoted words are left out too.
// It loads the master's two flows and its own msgtext.js, whose smsText() writes each message as the reader reads it,
// with its buttons, card and lines (msgtext.js lines 48 to 67). values.ts reads only the recorded list, so no check
// needs the master at run time. Run it again only when the master changes:
//   node actions/src/finalize/checks/common-words.record.mjs <the master's engine folder>
// The engine folder is the read-only copy, scratch/master-copy/engine (default: that path from the current folder).

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const table = path.join(path.dirname(fileURLToPath(import.meta.url)), "common-words.json");
const engine = path.resolve(process.argv[2] ?? "scratch/master-copy/engine");
const msgtextFile = path.join(engine, "work", "build", "msgtext.js");
const { smsText } = createRequire(import.meta.url)(msgtextFile);
const flows = ["master-A.json", "master-B.json"].map((file) => path.join(engine, "work", "master", file));

/** Rosie's lane in a message [from, to, text, element] (SPEC-master section 4: "san"). */
const ROSIE = "san";

/** Each of Rosie's message lines in a flow: every `say` and `addSay` message from Rosie, in steps, branches and variants. */
function linesOf(node, lines) {
  if (Array.isArray(node)) {
    for (const item of node) linesOf(item, lines);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if ((key === "say" || key === "addSay") && Array.isArray(value)) {
        for (const message of value) {
          if (Array.isArray(message) && message[0] === ROSIE && typeof message[2] === "string") {
            lines.push(smsText(message));
          }
        }
      } else {
        linesOf(value, lines);
      }
    }
  }
  return lines;
}

/** An auto-fill slot, {{name}} or {{name:example}}: a slot's name and example words are not the line's own. */
const SLOT = /\{\{[^{}]*\}\}/g;
/** Someone's words quoted inside Rosie's line ("Alex M. says: “sort it out”"): not Rosie's own words. */
const QUOTED = /“[^”]*”|"[^"]*"/g;
/** A link, an email address or a handle: never words (rosfield.com/v/s03 holds no word of the line). */
const ADDRESS = /\S*(?:@|:\/\/)\S*|(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}(?:\/\S*)?/gu;
/** A word: letters, with an apostrophe inside ("don't"), never touching a digit ("am" in "11am" is no word). */
const WORD = /(?<![\p{L}\p{N}])\p{L}+(?:['’]\p{L}+)*(?![\p{L}\p{N}])/gu;
const LOWER_CASE = /^\p{Ll}+(?:'\p{Ll}+)*$/u;

const lines = flows.flatMap((file) => linesOf(JSON.parse(readFileSync(file, "utf8")), []));
const words = new Set();
for (const line of lines) {
  for (const [word] of line.replace(SLOT, " ").replace(QUOTED, " ").replace(ADDRESS, " ").matchAll(WORD)) {
    const form = word.replace(/’/g, "'");
    if (LOWER_CASE.test(form)) words.add(form);
  }
}

const recorded = {
  source:
    "Every word the master writes in lower case in Rosie's own message lines: master-A.json and master-B.json, each say and addSay message from Rosie as msgtext.js smsText() writes it, without slots, quotes and links. Recorded by common-words.record.mjs.",
  lines: lines.length,
  words: [...words].sort(),
};
writeFileSync(table, `${JSON.stringify(recorded, null, 2)}\n`);
console.log(
  `recorded ${String(recorded.words.length)} common words from ${String(lines.length)} lines, in ${engine}`,
);
