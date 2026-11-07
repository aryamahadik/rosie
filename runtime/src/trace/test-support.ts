// Test helpers for the trace module: K-08 v1's schema loaded into Ajv 2020 (with the common and bundle schemas it
// refers to), and K-08's fixtures. Used only by the *.test.ts files beside it; never imported by the Worker, which
// cannot run Ajv.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";

const CONTRACTS_DIR = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const ID_BASE = "https://rosie.invalid/contracts/";
const EVENT_TRACE_SCHEMA = "event-trace/event-trace.v1.schema.json";

export function readContractJson(file: string): unknown {
  return JSON.parse(readFileSync(`${CONTRACTS_DIR}${file}`, "utf8")) as unknown;
}

/** An event-trace fixture by file name, from fixtures/ or fixtures/invalid/. */
export function eventTraceFixture(file: string): unknown {
  return readContractJson(`event-trace/fixtures/${file}`);
}

let ajv: Ajv2020 | undefined;

function loadedAjv(): Ajv2020 {
  if (ajv === undefined) {
    const created = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
    for (const file of [
      "common/formats.v1.schema.json",
      "bundle/bundle.v1.schema.json",
      EVENT_TRACE_SCHEMA,
    ]) {
      created.addSchema(readContractJson(file) as object);
    }
    ajv = created;
  }
  return ajv;
}

/** K-08 v1's validator for one definition (span, trace, traceSet, replyTime ...), with its shared schemas resolved. */
export function eventTraceValidator(definition: string): ValidateFunction {
  const validate = loadedAjv().getSchema(`${ID_BASE}${EVENT_TRACE_SCHEMA}#/$defs/${definition}`);
  if (validate === undefined) throw new Error(`K-08 v1 has no definition ${definition}`);
  return validate;
}

/** The schema's errors for `value` against a definition, one line each; empty when it is accepted. */
export function schemaErrors(definition: string, value: unknown): string[] {
  const validate = eventTraceValidator(definition);
  if (validate(value)) return [];
  return (validate.errors ?? []).map(
    (error) => `${error.instancePath === "" ? "(root)" : error.instancePath} ${error.message ?? ""}`,
  );
}
