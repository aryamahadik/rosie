// T-141, R4 (Master Corrections section 4): `santiago-handover/<path>` is read as the master path `<path>`. Proofs:
//   - masterPath() reads the old folder name off a path, and leaves any other path as written;
//   - every form of fixture set v1 names the old folder in its `spec` field, and read through masterPath() none does;
//   - no step of either master flow names the old folder, so R4 changes no compiled line and runs as no correction.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadMaster } from "../load/flow";
import { OLD_MASTER_FOLDER, masterPath, namesOldFolder } from "./r4";

const FORMS = new URL("../../../fixtures/v1/forms/", import.meta.url);

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (typeof value === "object" && value !== null)
    for (const item of Object.values(value)) strings(item, out);
  return out;
}

describe("R4: the master's old folder name", () => {
  it("reads santiago-handover/<path> as <path>, and leaves other paths as written", () => {
    expect(OLD_MASTER_FOLDER).toBe("santiago-handover/");
    expect(masterPath("santiago-handover/FRONTEND-SPEC.md")).toBe("FRONTEND-SPEC.md");
    expect(masterPath("santiago-handover/engine/work/prof/aba.json")).toBe("engine/work/prof/aba.json");
    expect(masterPath("/old/santiago-handover/RULES.md")).toBe("RULES.md");
    expect(masterPath("FRONTEND-SPEC.md")).toBe("FRONTEND-SPEC.md");
    expect(namesOldFolder("see santiago-handover/PROFESSION-MAP.md")).toBe(true);
    expect(namesOldFolder("PROFESSION-MAP.md")).toBe(false);
  });

  // Fixture set v1's forms were made again in the scratch copy after G3 pointed frontend-map.js at the copy's top
  // folder, so their spec fields already name the master path. Written the old way, as the handover's own forms write
  // them, each reads back to that same path.
  it("reads every form's spec field, written with the old folder, as the master path fixture set v1 names", () => {
    const files = readdirSync(FORMS).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(243);
    for (const name of files) {
      const form = JSON.parse(readFileSync(new URL(name, FORMS), "utf8")) as { spec?: unknown };
      const spec = strings(form.spec);
      expect(spec.length, `${name}: a spec field`).toBeGreaterThan(0);
      expect(spec.filter(namesOldFolder), name).toStrictEqual([]);
      expect(spec.map(masterPath), name).toStrictEqual(spec);
      expect(
        spec.map((path) => masterPath(`${OLD_MASTER_FOLDER}${path}`)),
        name,
      ).toStrictEqual(spec);
    }
  });

  it("finds the old folder in no step of either master flow", () => {
    const master = loadMaster();
    for (const flow of ["A", "B"] as const)
      expect(strings(Object.values(master[flow].steps)).filter(namesOldFolder), flow).toStrictEqual([]);
  });
});
