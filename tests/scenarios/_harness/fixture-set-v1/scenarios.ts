// Reads fixtures/v1/test-kit/SCENARIOS.md into typed scenarios: the "Per money combo" scenarios (one heading
// and its expected-result lines) and the "Cross-cutting cases" (one line each). A line the parser does not
// know is an error, never skipped: a changed file must not drop a scenario unseen. Each line keeps its line
// number in SCENARIOS.md, which is how KNOWN-STALE.md names the stale ones.

import { FixtureSetError } from "./reader";
import type { CrossCuttingScenario, FlowId, MoneyComboScenario, ScenarioLine, StaleNote } from "./types";

const COMBO_HEADING = /^### ([AB]) · `([^`]+)` on (\S+) \((.*)\)$/;
const CROSS_LINE = /^- \*\*(.+?)\*\*(?: \((.+?)\))?: (.*)$/;

export interface ParsedScenarios {
  moneyCombos: MoneyComboScenario[];
  crossCutting: CrossCuttingScenario[];
}

export function parseScenarios(markdown: string, staleNotes: readonly StaleNote[]): ParsedScenarios {
  const moneyCombos: MoneyComboScenario[] = [];
  const crossCutting: CrossCuttingScenario[] = [];
  type Section = "intro" | "combos" | "cross";
  let section: Section = "intro";
  let current: { scenario: MoneyComboScenario; lines: ScenarioLine[] } | undefined;

  const closeCurrent = (): void => {
    if (current === undefined) return;
    if (current.lines.length === 0) {
      throw new FixtureSetError(
        `SCENARIOS.md line ${String(current.scenario.line)}: a scenario with no expected result`,
      );
    }
    moneyCombos.push({ ...current.scenario, expectations: current.lines });
    current = undefined;
  };

  markdown.split("\n").forEach((text, index) => {
    const line = index + 1;
    if (text === "") return;
    if (text.startsWith("## ")) {
      closeCurrent();
      if (text.startsWith("## Per money combo")) section = "combos";
      else if (text.startsWith("## Cross-cutting cases")) section = "cross";
      else section = "intro";
      return;
    }
    if (section === "intro") return;
    if (section === "combos") {
      if (text.startsWith("### ")) {
        closeCurrent();
        const heading = COMBO_HEADING.exec(text);
        const [, flow, combo, shopId, serviceName] = heading ?? [];
        if (flow === undefined || combo === undefined || shopId === undefined || serviceName === undefined) {
          throw new FixtureSetError(
            `SCENARIOS.md line ${String(line)}: a heading in the expected form is needed: ${text}`,
          );
        }
        current = {
          scenario: {
            type: "money-combo",
            id: `${flow}:${combo}`,
            flow: flow as FlowId,
            combo,
            shopId,
            serviceName,
            line,
            expectations: [],
            stale: null,
          },
          lines: [],
        };
        return;
      }
      if (current !== undefined && text.startsWith("- ")) {
        current.lines.push({ line, text: text.slice(2) });
        return;
      }
      throw new FixtureSetError(
        `SCENARIOS.md line ${String(line)}: not a heading or an expected-result line: ${text}`,
      );
    }
    // Cross-cutting cases.
    const match = CROSS_LINE.exec(text);
    const [, title, ref, body] = match ?? [];
    if (title === undefined || body === undefined) {
      throw new FixtureSetError(`SCENARIOS.md line ${String(line)}: not a cross-cutting case: ${text}`);
    }
    crossCutting.push({
      type: "cross-cutting",
      id: `cross:${title}`,
      line,
      title,
      ref: ref ?? null,
      text: body,
      stale: staleNotes.find((note) => note.scenariosLine === line) ?? null,
    });
  });
  closeCurrent();

  // Every stale note must land on the scenario it names: a changed file whose line numbers moved fails here.
  for (const note of staleNotes) {
    const hit = crossCutting.find((scenario) => scenario.line === note.scenariosLine);
    if (hit?.title !== note.title) {
      throw new FixtureSetError(
        `KNOWN-STALE.md names SCENARIOS.md line ${String(note.scenariosLine)} as "${note.title}", but that line is ${
          hit === undefined ? "not a cross-cutting case" : `"${hit.title}"`
        }`,
      );
    }
  }
  for (const [list, what] of [
    [moneyCombos, "money-combo"],
    [crossCutting, "cross-cutting"],
  ] as const) {
    if (list.length === 0) throw new FixtureSetError(`SCENARIOS.md: no ${what} scenario found`);
    const ids = list.map((s) => s.id);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup !== undefined) throw new FixtureSetError(`SCENARIOS.md: ${what} scenario ${dup} appears twice`);
  }
  return { moneyCombos, crossCutting };
}
