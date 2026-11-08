// What decide's model answers in (T-368; CQ-25, DL-089, T-1068): the two structured-output schemas of the two-step
// wire form, the only form accepted live on claude-haiku-5-5 and claude-sonnet-5-5 (ai/spikes/decide-wire/FINDINGS.md:
// every one-call form, K-02's own `decideRead` included, was refused as too complex to compile).
//
//   step 1  one structured output: the text's language and each part's quote and verb (STAGE1_SCHEMA);
//   step 2  one structured output per part that is not no_op: the verb's own K-02 definition less its verb and quote
//           (STAGE2_SCHEMAS), sent side by side.
//
// Code maps the two into K-02 v1's `decideRead` unchanged (map.ts). The schemas are the spike's, byte for byte in
// meaning: step 1 as lib.mjs's stage1Schema(), step 2 cut from the frozen contract file itself exactly as the contracts'
// structured-subset lint bundles a definition (bundleSchema: every $ref resolved and its target copied into the
// schema's own $defs, since external $ref is refused), so what is sent cannot drift from K-02. Each schema is static
// (compiled grammars are cached 24 hours: T-360 finding 3); a choice id is a plain string, checked in code (check.ts).
// The Worker cannot read files, so the two contract files the definitions reach are imported here.

import formatsContract from "../../../contracts/common/formats.v1.schema.json";
import modelContract from "../../../contracts/model/model.v1.schema.json";
import type { JsonObject } from "../recorded-double/types";
import { VERBS, type Verb } from "./types";

/** The contract file of K-02 v1, as a path inside contracts/ (the subset lint's form). */
export const MODEL_FILE = "model/model.v1.schema.json";

/** The contract files decide's definitions reach, by their path inside contracts/. */
const DOCUMENTS: Readonly<Record<string, unknown>> = {
  [MODEL_FILE]: modelContract,
  "common/formats.v1.schema.json": formatsContract,
};

/** The K-02 v1 definition of each verb's part. */
export const PART_DEF: Readonly<Record<Verb, string>> = Object.freeze({
  choose: "choose",
  enter: "enter",
  ask: "ask",
  none_fits: "noneFits",
  pass_on: "passOn",
  hand_off: "handOff",
  redact: "redact",
  no_op: "noOp",
});

/** The verbs with a step 2: every verb but no_op, whose part is its verb and quote alone. */
export type FieldVerb = Exclude<Verb, "no_op">;
export const FIELD_VERBS: readonly FieldVerb[] = VERBS.filter((verb): verb is FieldVerb => verb !== "no_op");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodePointer = (token: string): string => token.replace(/~1/gu, "/").replace(/~0/gu, "~");

function documentOf(file: string): unknown {
  const document = DOCUMENTS[file];
  if (document === undefined) throw new Error(`a decide schema reaches ${file}, which is not bundled here`);
  return document;
}

function atPointer(document: unknown, pointer: string, where: string): unknown {
  if (pointer === "" || pointer === "/") return document;
  let node: unknown = document;
  for (const token of pointer.replace(/^\//u, "").split("/").map(decodePointer)) {
    if (!isRecord(node) && !Array.isArray(node)) throw new Error(`${where}: ${pointer} does not resolve`);
    node = (node as Record<string, unknown>)[token];
    if (node === undefined) throw new Error(`${where}: ${pointer} does not resolve`);
  }
  return node;
}

/** A relative file reference resolved against the file it is written in (posix paths inside contracts/). */
function resolveFile(from: string, relative: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const token of relative.split("/")) {
    if (token === "..") parts.pop();
    else if (token !== "." && token !== "") parts.push(token);
  }
  return parts.join("/");
}

/**
 * One definition of a contract file as a standalone schema whose every $ref is local: the contracts' structured-subset
 * lint's bundleSchema, written again for the Worker (same keys, same order, `$schema` and `$id` left out). The tests
 * hold it to the lint's own output.
 */
export function bundleContractDefinition(file: string, def: string): JsonObject {
  const rootPointer = `/$defs/${def}`;
  const keys = new Map<string, string>([[`${file}#${rootPointer}`, ""]]);
  const usedKeys = new Set<string>();
  const queue: { file: string; pointer: string; key: string }[] = [];
  const keyFor = (target: string, pointer: string): string => {
    const id = `${target}#${pointer}`;
    const known = keys.get(id);
    if (known !== undefined) return known;
    const tokens = pointer.split("/").filter(Boolean).map(decodePointer);
    const stem = (target.split("/").pop() ?? target)
      .replace(/\.schema\.json$/u, "")
      .replace(/[^A-Za-z0-9]+/gu, "_");
    let key = (tokens[tokens.length - 1] ?? stem).replace(/[^A-Za-z0-9_.-]+/gu, "_");
    if (usedKeys.has(key))
      key = `${stem}.${tokens.map((token) => token.replace(/[^A-Za-z0-9_-]+/gu, "_")).join(".")}`;
    while (usedKeys.has(key)) key = `${key}_`;
    usedKeys.add(key);
    keys.set(id, key);
    queue.push({ file: target, pointer, key });
    return key;
  };
  const rewrite = (node: unknown, from: string): unknown => {
    if (Array.isArray(node)) return node.map((item) => rewrite(item, from));
    if (!isRecord(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [keyword, value] of Object.entries(node)) {
      if (keyword === "$schema" || keyword === "$id") continue;
      if (keyword === "$ref" && typeof value === "string") {
        const [filePart = "", pointer = ""] = value.split("#");
        const key = keyFor(filePart === "" ? from : resolveFile(from, filePart), pointer);
        out.$ref = key === "" ? "#" : `#/$defs/${key}`;
      } else if (keyword === "properties" && isRecord(value)) {
        out.properties = Object.fromEntries(
          Object.entries(value).map(([name, sub]) => [name, rewrite(sub, from)]),
        );
      } else if (
        keyword === "enum" ||
        keyword === "const" ||
        keyword === "default" ||
        keyword === "required"
      ) {
        out[keyword] = value;
      } else {
        out[keyword] = rewrite(value, from);
      }
    }
    return out;
  };
  const root = rewrite(atPointer(documentOf(file), rootPointer, file), file) as JsonObject;
  const defs: Record<string, unknown> = {};
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    defs[next.key] = rewrite(atPointer(documentOf(next.file), next.pointer, next.file), next.file);
  }
  return structuredClone(Object.keys(defs).length === 0 ? root : { ...root, $defs: defs });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** Step 1: the text's language and each part's quote and verb, in the text's order (the spike's stage1Schema()). */
export const STAGE1_SCHEMA: JsonObject = deepFreeze({
  type: "object",
  properties: {
    language: { description: "The text's language (CQ-07 default).", $ref: "#/$defs/language" },
    parts: {
      description: "One entry per part of the text, in the text's order.",
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          quote: { description: "The part's exact words.", $ref: "#/$defs/nonEmptyText" },
          verb: { description: "The part's verb (arch 03 line 183).", type: "string", enum: [...VERBS] },
        },
        required: ["quote", "verb"],
        additionalProperties: false,
      },
    },
  },
  required: ["language", "parts"],
  additionalProperties: false,
  $defs: {
    language: bundleContractDefinition(MODEL_FILE, "language"),
    nonEmptyText: bundleContractDefinition(MODEL_FILE, "nonEmptyText"),
  },
});

/** Step 2 for one verb: its K-02 part less its verb and quote, which step 1 gave (the spike's stage2Schema(verb)). */
export function stage2Schema(verb: FieldVerb): JsonObject {
  const schema = bundleContractDefinition(MODEL_FILE, PART_DEF[verb]);
  const properties = schema.properties as Record<string, unknown>;
  schema.properties = Object.fromEntries(
    Object.entries(properties).filter(([name]) => name !== "verb" && name !== "quote"),
  );
  schema.required = (schema.required as string[]).filter((name) => name !== "verb" && name !== "quote");
  return schema;
}

/** The step-2 schema of each verb that has one, built once. */
export const STAGE2_SCHEMAS: Readonly<Record<FieldVerb, JsonObject>> = deepFreeze(
  Object.fromEntries(FIELD_VERBS.map((verb) => [verb, stage2Schema(verb)])) as Record<FieldVerb, JsonObject>,
);

/** What each verb's K-02 part holds, in K-02's order (its `required` list). */
export const PART_KEYS: Readonly<Record<Verb, readonly string[]>> = deepFreeze({
  choose: ["verb", "quote", "question", "choice", "fields"],
  enter: ["verb", "quote", "choice", "fields"],
  ask: ["verb", "quote", "questions", "unclear"],
  none_fits: ["verb", "quote", "why"],
  pass_on: ["verb", "quote", "words"],
  hand_off: ["verb", "quote", "reason", "about"],
  redact: ["verb", "quote", "words"],
  no_op: ["verb", "quote"],
});
