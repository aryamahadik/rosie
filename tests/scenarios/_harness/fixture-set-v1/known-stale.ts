// Reads fixtures/v1/KNOWN-STALE.md (T-002) into typed notes: the scenario lines that C9 overrides (Q-36), and the
// gaps the demo shops are known to keep. The file is parsed, not copied, so the list cannot drift from it.

import { FixtureSetError } from "./reader";
import type { KnownGap, StaleNote } from "./types";

export interface KnownStale {
  staleNotes: StaleNote[];
  knownGaps: KnownGap[];
}

const STALE_ROW = /^\| `test-kit\.js` line (\d+) \| /;
const LINE_NOTE = /`test-kit\/SCENARIOS\.md` line (\d+) \(([^)]*)\) is not listed/;
const GAP_ROW = /^\| ([a-z0-9][a-z0-9, -]*) \| `(\w+)` \| (.*) \|$/;

function cells(row: string): string[] {
  return row.replace(/^\| /, "").replace(/ \|$/, "").split(" | ");
}

/** The text between the first pair of backticks of a table cell. */
function code(cell: string): string {
  const match = /^`(.*)`$/.exec(cell.trim());
  return match?.[1] ?? cell.trim();
}

function titleOf(text: string): string {
  const match = /^- \*\*(.+?)\*\*/.exec(text);
  if (match?.[1] === undefined)
    throw new FixtureSetError(`KNOWN-STALE.md: cannot read a title from: ${text}`);
  return match[1];
}

export function parseKnownStale(markdown: string): KnownStale {
  const staleNotes: StaleNote[] = [];
  const knownGaps: KnownGap[] = [];
  for (const row of markdown.split("\n")) {
    const stale = STALE_ROW.exec(row);
    if (stale?.[1] !== undefined) {
      const parts = cells(row);
      const where = parts[3];
      const scenariosLine = where === undefined ? undefined : /line (\d+)$/.exec(where.trim())?.[1];
      const [, textStarts, why, , useInstead] = parts;
      if (
        scenariosLine === undefined ||
        textStarts === undefined ||
        why === undefined ||
        useInstead === undefined
      ) {
        throw new FixtureSetError(`KNOWN-STALE.md: a stale row is not in the expected form: ${row}`);
      }
      staleNotes.push({
        kind: "listed",
        testKitJsLine: Number(stale[1]),
        scenariosLine: Number(scenariosLine),
        title: titleOf(code(textStarts)),
        why,
        useInstead,
      });
      continue;
    }
    const gap = GAP_ROW.exec(row);
    if (gap?.[1] !== undefined && gap[2] !== undefined && gap[3] !== undefined) {
      knownGaps.push({
        shops: gap[1].split(",").map((id) => id.trim()),
        field: gap[2],
        cause: gap[3],
      });
    }
  }
  // A line the file mentions in its text, with no row of its own (SCENARIOS.md line 529, Lost phone, D100).
  const note = LINE_NOTE.exec(markdown);
  if (note?.[1] !== undefined && note[2] !== undefined) {
    staleNotes.push({
      kind: "noted",
      testKitJsLine: null,
      scenariosLine: Number(note[1]),
      title: note[2].split(",")[0]?.trim() ?? note[2],
      why: "KNOWN-STALE.md: reads the same way for a new number; C9 wins there too",
      useInstead: "C9: a code is never texted to a mobile that has not texted Rosie",
    });
  }
  if (staleNotes.filter((n) => n.kind === "listed").length === 0) {
    throw new FixtureSetError("KNOWN-STALE.md: no stale row found");
  }
  if (knownGaps.length === 0) throw new FixtureSetError("KNOWN-STALE.md: no known gap found");
  return { staleNotes, knownGaps };
}
