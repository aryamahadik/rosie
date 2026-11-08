// What the composer's model answers in (T-373, C-118): K-03 v1's `$defs/plan` as the structured-output schema (arch 07
// line 397: "It returns the plan as structured output"). K-03's README: "What goes to the model is `$defs/plan` alone,
// bundled with the four definitions it uses, never the root". It is cut from the frozen contract file itself, as the
// contracts' structured-subset lint bundles a definition (bundleSchema: every $ref resolved into the schema's own $defs,
// `$schema` and `$id` left out; an external $ref is refused, T-360 finding 3), so what is sent cannot drift from K-03.
// The plan's definitions refer only to each other, so nothing outside the file is reached. The schema is static: it is
// built once, and the slot list and the formats are fixed enums, never built per row (compiled grammars are cached 24
// hours: T-360 finding 3). The lists the checks read (check.ts) come from the same file. The Worker cannot read files,
// so the contract file is imported here.

import planContract from "../../../contracts/message-plan/message-plan.v1.schema.json";
import type { JsonObject } from "../recorded-double/types";

/** The contract file of K-03 v1, as a path inside contracts/ (the subset lint's form). */
export const PLAN_FILE = "message-plan/message-plan.v1.schema.json";
/** The definition the model answers in. */
export const PLAN_DEF = "plan";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** K-03 v1's definitions, as the contract file holds them. */
const DEFS = (planContract as unknown as { $defs: Readonly<Record<string, unknown>> }).$defs;

function definition(name: string): Record<string, unknown> {
  const node = DEFS[name];
  if (!isRecord(node)) throw new Error(`K-03 v1 has no definition ${name}`);
  return node;
}

const LOCAL_REF = /^#\/\$defs\/([^/]+)$/u;

/**
 * One definition of K-03 v1 as a standalone schema whose every $ref is local: the contracts' structured-subset lint's
 * bundleSchema for a definition that reaches only its own file (same keys, `$schema` and `$id` left out). The tests
 * hold it to the lint's own output.
 */
export function bundlePlanDefinition(def: string = PLAN_DEF): JsonObject {
  const queued = new Set<string>();
  const queue: string[] = [];
  const refTo = (ref: string): string => {
    const name = LOCAL_REF.exec(ref)?.[1];
    if (name === undefined)
      throw new Error(`K-03's ${def} reaches ${ref}, which is not a definition of its file`);
    if (name === def) return "#";
    if (!queued.has(name)) {
      queued.add(name);
      queue.push(name);
    }
    return `#/$defs/${name}`;
  };
  const rewrite = (node: unknown): unknown => {
    if (Array.isArray(node)) return (node as unknown[]).map(rewrite);
    if (!isRecord(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [keyword, value] of Object.entries(node)) {
      if (keyword === "$schema" || keyword === "$id") continue;
      if (keyword === "$ref" && typeof value === "string") {
        out.$ref = refTo(value);
      } else if (keyword === "properties" && isRecord(value)) {
        out.properties = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, rewrite(sub)]));
      } else if (
        keyword === "enum" ||
        keyword === "const" ||
        keyword === "default" ||
        keyword === "required"
      ) {
        out[keyword] = value;
      } else {
        out[keyword] = rewrite(value);
      }
    }
    return out;
  };
  const root = rewrite(definition(def)) as JsonObject;
  const defs: Record<string, unknown> = {};
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    defs[next] = rewrite(definition(next));
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

/** The structured-output schema every composer call sends: K-03 v1's plan, bundled, built once. */
export const PLAN_SCHEMA: JsonObject = deepFreeze(bundlePlanDefinition());

/** A K-03 v1 enum of strings, by its definition's name. */
function enumOf(name: string): readonly string[] {
  const values: unknown = definition(name).enum;
  if (!Array.isArray(values)) throw new Error(`K-03 v1's ${name} is not an enum`);
  const strings = (values as unknown[]).filter((value): value is string => typeof value === "string");
  if (strings.length !== values.length) throw new Error(`K-03 v1's ${name} is not an enum of strings`);
  return Object.freeze(strings);
}

/** A K-03 v1 pattern, by its definition's name, as Ajv reads it (a unicode RegExp, not anchored unless it says so). */
function patternOf(name: string): RegExp {
  const pattern = definition(name).pattern;
  if (typeof pattern !== "string") throw new Error(`K-03 v1's ${name} has no pattern`);
  return new RegExp(pattern, "u");
}

/** K-03 `format`: the closed list of five (arch 07 lines 373 to 393). */
export const FORMATS = enumOf("format");
/** K-03 `lineRole`: first, fact, action (arch 07 line 353). */
export const LINE_ROLES = enumOf("lineRole");
/** K-03 `slotName`: the 52 slots of the vocabulary; hold is not one (D66). */
export const SLOT_NAMES = enumOf("slotName");
/** K-03 `linkSlot`. */
export const LINK_SLOTS = enumOf("linkSlot");
/** K-03 `readerRole`. */
export const READER_ROLES = enumOf("readerRole");
/** K-03 `channel`. */
export const CHANNELS = enumOf("channel");
/** K-03 `situation`: code's tone tag (arch 07 line 357). */
export const SITUATIONS = enumOf("situation");
/** K-03 `reach`. */
export const REACHES = enumOf("reach");
/** K-03 `slottedText`: every {{ opens a slot of the vocabulary. */
export const SLOTTED_TEXT = patternOf("slottedText");
/** K-03 `language`: a two-letter code. */
export const LANGUAGE = patternOf("language");
