// TEMPORARY exploration (deleted before commit).
import { readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";

const root = new URL("../../../contracts/", import.meta.url);
const read = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(file, root), "utf8")) as Record<string, unknown>;

function refsOf(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) refsOf(item, out);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      if (key === "$ref" && typeof inner === "string") out.add(inner.split("#")[0] ?? "");
      else refsOf(inner, out);
    }
  }
}

it("explore", () => {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = ["tool-api/tool-api.v1.schema.json", "event-trace/event-trace.v1.1.schema.json"];
  while (queue.length > 0) {
    const file = queue.shift() ?? "";
    if (seen.has(file)) continue;
    seen.add(file);
    const refs = new Set<string>();
    refsOf(read(file), refs);
    const dir = file.split("/").slice(0, -1).join("/");
    for (const ref of refs) {
      if (ref === "") continue;
      const resolved = new URL(ref, new URL(`${dir}/x`, "https://h/")).pathname.slice(1);
      queue.push(resolved);
    }
  }
  out.push(`closure: ${[...seen].join(" ")}`);

  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  for (const file of seen) ajv.addSchema(read(file));
  const k09 = read("tool-api/tool-api.v1.schema.json");
  const names = ((k09.$defs as Record<string, { enum?: string[] }>).callName?.enum ?? []);
  const started = Date.now();
  for (const name of names) {
    for (const part of ["request", "response", "errors"]) {
      const v = ajv.getSchema(`https://rosie.invalid/contracts/tool-api/tool-api.v1.schema.json#/$defs/${name}.${part}`);
      if (v === undefined) out.push(`MISSING ${name}.${part}`);
    }
  }
  out.push(`compile ms: ${String(Date.now() - started)}`);
  const span = ajv.getSchema("https://rosie.invalid/contracts/event-trace/event-trace.v1.1.schema.json#/$defs/span");
  out.push(`span validator: ${String(span !== undefined)}`);
  const validate = ajv.getSchema(`https://rosie.invalid/contracts/tool-api/tool-api.v1.schema.json#/$defs/saveSetupStep.request`);
  validate?.({});
  out.push(`saveSetupStep {} errors: ${JSON.stringify(validate?.errors?.slice(0, 5))} count=${String(validate?.errors?.length)}`);
  const sfx = read("tool-api/fixtures/setup-s1-04-companies.json") as { request: Record<string, unknown> };
  validate?.({ ...sfx.request, phone: "+15555550100" });
  out.push(`saveSetupStep extra errors: ${JSON.stringify(validate?.errors)} count=${String(validate?.errors?.length)}`);
  const gate = ajv.getSchema(`https://rosie.invalid/contracts/tool-api/tool-api.v1.schema.json#/$defs/gateAndCommit.request`);
  gate?.({ caller: 5 });
  out.push(`gate bad errors count=${String(gate?.errors?.length)} first=${JSON.stringify(gate?.errors?.slice(0, 3))}`);
  writeFileSync(
    "/private/tmp/claude-501/-Users-aryamahadik-Downloads-Rosfield-Main-rosie/d9982744-6798-4bc7-ad8e-3fc2a5092574/scratchpad/explore4.txt",
    out.join("\n"),
  );
});
