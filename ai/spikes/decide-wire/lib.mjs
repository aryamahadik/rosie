// T-1068 spike (CQ-25): how decide reaches the model. Kept free of network and keys so it can be tested offline.
// ES module; uses ajv (through the contracts' helpers) and Node 22 built-ins.
//
// K-02 v1's decideRead (contracts/model/model.v1.schema.json, frozen) is refused as one structured-output schema
// ("Schema is too complex.", T-360 and T-1066). This module builds three wire forms, each mapped by code into
// decideRead unchanged:
//   tools     (a) one strict tool per verb; the model calls one tool per part of the text, in the text's order.
//   tools-flat (a') the same eight tools with each field's value as typed text (the envelope's field), so no union.
//   envelope  (b) one structured output: a flat part with the verb as an enum, no union of objects; each field's
//                 value travels as text with its type, and code turns it back into K-02's value.
//   two-step  (c) two calls: the parts with their verbs (one structured output), then each part's own fields (one
//                 structured output per part, the verb's own K-02 schema less its verb and quote).
// Every wire schema is static (compiled once, cached 24 hours: T-360 finding 3). The tool and stage-2 schemas are
// cut from the frozen contract's own definitions by bundleSchema(), so they cannot drift from K-02.

import path from "node:path";
import { CONTRACTS_DIR, createAjv, idFor, readJson } from "../../../contracts/scripts/lib.mjs";
import { bundleSchema, lintSchema } from "../../../contracts/scripts/structured-subset-lint.mjs";

export const API_URL = "https://api.anthropic.com/v1/messages";
export const API_VERSION = "2026-10-21";
export const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"];
/** This probe's own cap on live calls, counted from its own results.jsonl (the lead's brief; NQ-R2). */
export const MAX_CALLS = 12;
export const MAX_TOKENS = 4096;
/** At most this many stage-2 calls for one two-step read; parts past it are not measured. */
export const MAX_STAGE2 = 3;

const MODEL_SCHEMA = "model/model.v1.schema.json";
const CONTRACT_FILES = [
  "common/formats.v1.schema.json",
  "bundle/bundle.v1.schema.json",
  "model/model.v1.schema.json",
];

export const CANDIDATES = ["tools", "tools-flat", "envelope", "two-step"];
/** The candidates that answer in one call, in the order the live run prefers them for Sonnet and the second case. */
export const ONE_CALL = ["tools", "tools-flat", "envelope"];
const isTools = (candidate) => candidate === "tools" || candidate === "tools-flat";

/** K-02's eight verbs (arch 03 line 183) and the definition each one's part has in model.v1. */
export const VERBS = Object.freeze([
  { verb: "choose", def: "choose" },
  { verb: "enter", def: "enter" },
  { verb: "ask", def: "ask" },
  { verb: "none_fits", def: "noneFits" },
  { verb: "pass_on", def: "passOn" },
  { verb: "hand_off", def: "handOff" },
  { verb: "redact", def: "redact" },
  { verb: "no_op", def: "noOp" },
]);
const VERB_NAMES = VERBS.map((v) => v.verb);
const defOf = (verb) => VERBS.find((v) => v.verb === verb)?.def;

/** The envelope's field types: K-02's fieldValue branches (answerField's zone, id and choice travel as text). */
export const VALUE_TYPES = ["text", "integer", "boolean", "money", "time"];

export const contractJson = (file) => readJson(path.join(CONTRACTS_DIR, file), file);
/** A copy of `object` without the named keys. */
const omit = (object, keys) =>
  Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));

// ---------------------------------------------------------------------------------------------------------
// The wire schemas.

/** One K-02 definition, bundled as the gateway sends it, with the named properties taken out. */
function contractDef(def, drop = []) {
  const schema = bundleSchema({ schema: MODEL_SCHEMA, def });
  schema.properties = omit(schema.properties, drop);
  schema.required = schema.required.filter((name) => !drop.includes(name));
  return schema;
}

const languageDef = () => bundleSchema({ schema: MODEL_SCHEMA, def: "language" });
const nonEmptyTextDef = () => bundleSchema({ schema: MODEL_SCHEMA, def: "nonEmptyText" });

const str = (description) => ({ description, type: "string" });

/** The $defs a schema reaches from its root through local $refs; the others are dropped. */
function pruneDefs(schema) {
  const reached = new Set();
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$defs") continue;
      if (key === "$ref" && typeof value === "string" && value.startsWith("#/$defs/")) {
        const name = value.slice("#/$defs/".length);
        if (!reached.has(name)) {
          reached.add(name);
          visit(schema.$defs[name]);
        }
      } else visit(value);
    }
  };
  visit(schema);
  schema.$defs = Object.fromEntries(Object.entries(schema.$defs ?? {}).filter(([name]) => reached.has(name)));
  return schema;
}

/** The envelope's field: its value as text with its type, so no union of objects is left (K-02's field has one). */
function flatFieldDef() {
  return {
    description: "One field, its value written as text with its type.",
    type: "object",
    properties: {
      name: str("The field's name, as the choice lists it."),
      type: { description: "The value's type.", type: "string", enum: VALUE_TYPES },
      value: str(
        "text as is; integer as digits; boolean as true or false; money as whole cents and the currency code (1200 USD); time as the UTC instant and the IANA zone (2026-11-12T19:00:00Z America/New_York).",
      ),
      words: { description: "The exact words the value comes from.", $ref: "#/$defs/nonEmptyText" },
    },
    required: ["name", "type", "value", "words"],
    additionalProperties: false,
  };
}

/**
 * (a) The input schema of the tool for one verb: K-02's part less its verb (the tool's name says it), plus language.
 * With flat, K-02's field (whose value is a union of 5, two of them objects) is replaced by the envelope's typed-text
 * field, so the eight tools carry no union at all (the documentation's "simplify nested structures").
 */
export function toolInputSchema(verb, { flat = false } = {}) {
  const schema = contractDef(defOf(verb), ["verb"]);
  schema.$defs = schema.$defs ?? {};
  if ("language" in schema.$defs) throw new Error(`${verb}: $defs/language is taken`);
  schema.$defs.language = languageDef();
  if (flat && "field" in schema.$defs) schema.$defs.field = flatFieldDef();
  schema.properties = {
    language: {
      description: "The text's language, the same in every call of this turn (CQ-07 default).",
      $ref: "#/$defs/language",
    },
    ...schema.properties,
  };
  schema.required = ["language", ...schema.required];
  return flat ? pruneDefs(schema) : schema;
}

/** (a) The eight strict tools, one per verb, each described by K-02's own description of its part. */
export function decideTools({ flat = false } = {}) {
  const model = contractJson(MODEL_SCHEMA);
  return VERBS.map(({ verb, def }) => ({
    name: verb,
    description: model.$defs[def].description,
    strict: true,
    input_schema: toolInputSchema(verb, { flat }),
  }));
}

/** (b) The flat envelope: every part has every verb's fields; the verb is an enum; no union anywhere. */
export function envelopeSchema() {
  return {
    type: "object",
    properties: {
      language: { description: "The text's language (CQ-07 default).", $ref: "#/$defs/language" },
      parts: {
        description: "One entry per part of the text, in the text's order.",
        type: "array",
        minItems: 1,
        items: { $ref: "#/$defs/part" },
      },
    },
    required: ["language", "parts"],
    additionalProperties: false,
    $defs: {
      language: languageDef(),
      nonEmptyText: nonEmptyTextDef(),
      part: {
        description: "One part with its verb. Fill only what the verb uses; leave the rest empty.",
        type: "object",
        properties: {
          verb: { description: "The part's verb (arch 03 line 183).", type: "string", enum: VERB_NAMES },
          quote: { description: "The part's exact words.", $ref: "#/$defs/nonEmptyText" },
          question: str("choose: the chosen choice's question, as listed; otherwise empty."),
          choice: str("choose or enter: the choice id; otherwise empty."),
          fields: {
            description: "choose or enter: the fields with their words; otherwise empty.",
            type: "array",
            items: { $ref: "#/$defs/field" },
          },
          questions: {
            description: "ask: the questions it could answer; otherwise empty.",
            type: "array",
            items: { type: "string" },
          },
          unclear: str("ask: what is unclear; otherwise empty."),
          why: str("none_fits: why nothing fits; otherwise empty."),
          words: str("pass_on or redact: the words; otherwise empty."),
          reason: str("hand_off: why it goes to a person; otherwise empty."),
          about: {
            description:
              "hand_off: ownerOrStaff for a report about the owner or staff, other for any other hand-off; none for every other verb.",
            type: "string",
            enum: ["ownerOrStaff", "other", "none"],
          },
        },
        required: [
          "verb",
          "quote",
          "question",
          "choice",
          "fields",
          "questions",
          "unclear",
          "why",
          "words",
          "reason",
          "about",
        ],
        additionalProperties: false,
      },
      field: flatFieldDef(),
    },
  };
}

/** (c) Stage 1: the parts and their verbs only. */
export function stage1Schema() {
  return {
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
            verb: { description: "The part's verb (arch 03 line 183).", type: "string", enum: VERB_NAMES },
          },
          required: ["quote", "verb"],
          additionalProperties: false,
        },
      },
    },
    required: ["language", "parts"],
    additionalProperties: false,
    $defs: { language: languageDef(), nonEmptyText: nonEmptyTextDef() },
  };
}

/** (c) Stage 2 for one verb: K-02's part less its verb and quote (stage 1 gave both); null for no_op (nothing left). */
export function stage2Schema(verb) {
  if (verb === "no_op") return null;
  return contractDef(defOf(verb), ["verb", "quote"]);
}

/** Every wire schema with a name, for compiling and linting. */
export function wireSchemas() {
  const out = {};
  for (const { verb } of VERBS) out[`tool:${verb}`] = toolInputSchema(verb);
  for (const { verb } of VERBS) out[`tool-flat:${verb}`] = toolInputSchema(verb, { flat: true });
  out.envelope = envelopeSchema();
  out.stage1 = stage1Schema();
  for (const { verb } of VERBS) {
    const schema = stage2Schema(verb);
    if (schema !== null) out[`stage2:${verb}`] = schema;
  }
  return out;
}

/** A validator per wire schema (Ajv 2020 strict, as the contracts compile theirs). */
export function compileWire() {
  return Object.fromEntries(
    Object.entries(wireSchemas()).map(([name, schema]) => [name, createAjv().compile(schema)]),
  );
}

/** The frozen decideRead, compiled from the contract files themselves (as T-1066's frozen.mjs does). */
export function compileDecideRead() {
  const ajv = createAjv();
  for (const file of CONTRACT_FILES) ajv.addSchema(contractJson(file));
  const validate = ajv.getSchema(`${idFor(MODEL_SCHEMA)}#/$defs/decideRead`);
  if (validate === undefined) throw new Error("decideRead did not compile");
  return validate;
}

/**
 * The structured schemas one request carries, linted together: the contracts' subset lint on each, and the
 * per-request totals (24 optional properties, 16 union parameters, 20 strict tools; Anthropic, "Structured
 * outputs", explicit limits) summed across them.
 */
export function lintRequest(body) {
  const schemas = [
    ...(body.tools ?? []).map((tool) => tool.input_schema),
    ...(body.output_config?.format ? [body.output_config.format.schema] : []),
  ];
  const errors = [];
  let optionalProperties = 0;
  let unionParameters = 0;
  for (const schema of schemas) {
    const result = lintSchema(schema);
    errors.push(...result.errors);
    optionalProperties += result.counts.optionalProperties;
    unionParameters += result.counts.unionParameters;
  }
  const strictTools = (body.tools ?? []).filter((tool) => tool.strict === true).length;
  if (optionalProperties > 24)
    errors.push(`${optionalProperties} optional properties in the request (limit 24)`);
  if (unionParameters > 16) errors.push(`${unionParameters} union parameters in the request (limit 16)`);
  if (strictTools > 20) errors.push(`${strictTools} strict tools in the request (limit 20)`);
  return {
    errors,
    optionalProperties,
    unionParameters,
    strictTools,
    schemaBytes: schemas.reduce((sum, s) => sum + JSON.stringify(s).length, 0),
  };
}

// ---------------------------------------------------------------------------------------------------------
// From K-02 to each wire form (to prove the mapping both ways offline) and from each wire form to K-02.

/** K-02 fieldValue -> the envelope's typed text. */
export function encodeValue(value) {
  if (typeof value === "string") return { type: "text", value };
  if (typeof value === "boolean") return { type: "boolean", value: String(value) };
  if (Number.isInteger(value)) return { type: "integer", value: String(value) };
  if (value !== null && typeof value === "object" && "cents" in value) {
    return { type: "money", value: `${value.cents} ${value.currency}` };
  }
  if (value !== null && typeof value === "object" && "utc" in value) {
    return { type: "time", value: `${value.utc} ${value.zone}` };
  }
  throw new Error(`no wire type for ${JSON.stringify(value)}`);
}

/** The envelope's typed text -> K-02 fieldValue, or an error. Code re-parses every value anyway (arch 03 line 185). */
export function decodeValue(type, text) {
  if (type === "text") return { value: text };
  if (type === "boolean") {
    return text === "true" || text === "false"
      ? { value: text === "true" }
      : { error: `boolean "${text}" is not true or false` };
  }
  if (type === "integer") {
    return /^-?[0-9]+$/.test(text) ? { value: Number(text) } : { error: `integer "${text}" is not digits` };
  }
  if (type === "money") {
    const match = /^(-?[0-9]+) ([A-Z]{3})$/.exec(text.trim());
    return match === null
      ? { error: `money "${text}" is not "<cents> <currency>"` }
      : { value: { cents: Number(match[1]), currency: match[2] } };
  }
  if (type === "time") {
    const match = /^(\S+) (\S+)$/.exec(text.trim());
    return match === null
      ? { error: `time "${text}" is not "<utc> <zone>"` }
      : { value: { utc: match[1], zone: match[2] } };
  }
  return { error: `unknown type ${type}` };
}

/** K-02 fields -> the typed-text fields of the envelope and the flat tools. */
const encodeFields = (fields) =>
  fields.map((field) => ({ name: field.name, ...encodeValue(field.value), words: field.words }));

/** Typed-text fields -> K-02 fields; a value that does not parse is kept as sent and named in `errors`. */
function decodeFields(fields, errors, where) {
  return fields.map((field) => {
    const decoded = decodeValue(field.type, field.value);
    if (decoded.error !== undefined) errors.push(`${where} field ${field.name}: ${decoded.error}`);
    return { name: field.name, value: decoded.value ?? field.value, words: field.words };
  });
}

/** (a) A decideRead as the tool_use blocks the model would send (flat: each field's value as typed text). */
export function toToolBlocks(read, { flat = false } = {}) {
  return read.parts.map((part, k) => {
    if (!VERB_NAMES.includes(part.verb)) throw new Error(`no tool for verb ${part.verb}`);
    const input = { language: read.language, ...omit(part, ["verb"]) };
    if (flat && Array.isArray(part.fields)) input.fields = encodeFields(part.fields);
    return { type: "tool_use", id: `toolu_${k + 1}`, name: part.verb, input };
  });
}

/** (b) A decideRead as the envelope the model would send. */
export function toEnvelope(read) {
  return {
    language: read.language,
    parts: read.parts.map((part) => {
      if (!VERB_NAMES.includes(part.verb)) throw new Error(`no verb ${part.verb} in the envelope's enum`);
      return {
        verb: part.verb,
        quote: part.quote,
        question: part.question ?? "",
        choice: part.choice ?? "",
        fields: encodeFields(part.fields ?? []),
        questions: part.questions ?? [],
        unclear: part.unclear ?? "",
        why: part.why ?? "",
        words: part.words ?? "",
        reason: part.reason ?? "",
        about: part.about ?? "none",
      };
    }),
  };
}

/** (c) A decideRead as the two stages the model would send. */
export function toTwoStep(read) {
  return {
    stage1: {
      language: read.language,
      parts: read.parts.map((part) => {
        if (!VERB_NAMES.includes(part.verb)) throw new Error(`no verb ${part.verb} in stage 1's enum`);
        return { quote: part.quote, verb: part.verb };
      }),
    },
    stage2: read.parts.map((part) => {
      return part.verb === "no_op" ? null : omit(part, ["verb", "quote"]);
    }),
  };
}

/** What each verb's K-02 part holds besides verb and quote, in K-02's order. */
const ENVELOPE_KEYS = {
  choose: ["question", "choice", "fields"],
  enter: ["choice", "fields"],
  ask: ["questions", "unclear"],
  none_fits: ["why"],
  pass_on: ["words"],
  hand_off: ["reason", "about"],
  redact: ["words"],
  no_op: [],
};

/**
 * (a) The response's tool_use blocks -> a decideRead. The tool's name is the verb (strict: a valid name, an input
 * that validates); the parts keep the blocks' order. Every call must give the same language. With flat, each
 * field's typed text becomes K-02's value.
 * @returns {{ read?: object, errors: string[] }}
 */
export function mapToolBlocks(content, { flat = false } = {}) {
  const blocks = (Array.isArray(content) ? content : []).filter((block) => block?.type === "tool_use");
  const errors = [];
  if (blocks.length === 0) return { errors: ["no tool call"] };
  const languages = [...new Set(blocks.map((block) => block.input?.language))];
  if (languages.length !== 1) errors.push(`the calls give different languages: ${languages.join(", ")}`);
  const parts = blocks.map((block, k) => {
    if (!VERB_NAMES.includes(block.name)) errors.push(`unknown tool ${block.name}`);
    const part = { verb: block.name, ...omit(block.input ?? {}, ["language"]) };
    if (flat && Array.isArray(part.fields)) part.fields = decodeFields(part.fields, errors, `part ${k + 1}`);
    return part;
  });
  return { read: { language: languages[0], parts }, errors };
}

/**
 * (b) The envelope -> a decideRead: each part keeps only what its verb holds in K-02, and each field's typed text
 * becomes K-02's value. A hand_off with about "none", or a value that does not parse, is a mapping error.
 * @returns {{ read?: object, errors: string[] }}
 */
export function mapEnvelope(output) {
  if (output === null || typeof output !== "object" || !Array.isArray(output.parts)) {
    return { errors: ["no envelope"] };
  }
  const errors = [];
  const parts = output.parts.map((wire, k) => {
    const part = { verb: wire.verb, quote: wire.quote };
    for (const key of ENVELOPE_KEYS[wire.verb] ?? []) {
      if (key === "fields") {
        part.fields = decodeFields(wire.fields ?? [], errors, `part ${k + 1}`);
      } else if (key === "about" && wire.about === "none") {
        errors.push(`part ${k + 1}: hand_off needs about ownerOrStaff or other, not none`);
        part.about = wire.about;
      } else {
        part[key] = wire[key];
      }
    }
    if (ENVELOPE_KEYS[wire.verb] === undefined) errors.push(`part ${k + 1}: unknown verb ${wire.verb}`);
    return part;
  });
  return { read: { language: output.language, parts }, errors };
}

/**
 * (c) Stage 1 and each part's stage 2 -> a decideRead. stage2[k] is null for no_op, undefined when not measured.
 * @returns {{ read?: object, errors: string[] }}
 */
export function mapTwoStep(stage1, stage2) {
  if (stage1 === null || typeof stage1 !== "object" || !Array.isArray(stage1.parts)) {
    return { errors: ["no stage 1 output"] };
  }
  const errors = [];
  const parts = stage1.parts.map((head, k) => {
    const rest = stage2[k];
    if (head.verb === "no_op") return { verb: head.verb, quote: head.quote };
    if (rest === undefined || rest === null) {
      errors.push(`part ${k + 1} (${head.verb}): no stage 2 output`);
      return { verb: head.verb, quote: head.quote };
    }
    return { verb: head.verb, quote: head.quote, ...rest };
  });
  return { read: { language: stage1.language, parts }, errors };
}

/** What two reads must agree on (arch 02 line 119): each part's verb, choice and field values, in order. */
export function agreementKey(read) {
  return JSON.stringify(
    (read?.parts ?? []).map((part) => [
      part.verb,
      part.choice ?? null,
      (part.fields ?? []).map((field) => [field.name, field.value]),
    ]),
  );
}

// ---------------------------------------------------------------------------------------------------------
// The prompts: built from the frozen K-02 fixtures, so every name and value is the fixtures' own (Sam Lee and his
// two businesses are the contract fixtures' made-up cast; hard rule 9: no real customer data).

/** The live cases: a context and the decide fixture whose first read is the expected answer. */
export const CASES = Object.freeze({
  "two-requests": {
    context: "model/fixtures/context-two-requests.json",
    expected: "model/fixtures/decide-two-requests.json",
  },
  "s1-02": {
    context: "model/fixtures/context-s1-02.json",
    expected: "model/fixtures/decide-s1-02-choose.json",
  },
});

export function expectedRead(caseName) {
  return contractJson(CASES[caseName].expected).reads[0].output;
}

function choiceLine(c) {
  const how =
    c.kind === "option" || c.kind === "hub" || c.kind === "whichBooking"
      ? `${c.kind}; choose, question ${c.question}`
      : `${c.kind}${c.door ? ` ${c.door}` : ""}${c.anytimeRow ? ` ${c.anytimeRow}` : ""}; enter`;
  const fields =
    c.fields.length > 0 ? ` Fields: ${c.fields.map((f) => `${f.name} (${f.type})`).join(", ")}.` : "";
  return `${c.choiceId} (${how}): ${c.label}. ${c.definition}${fields}`;
}

/** The turn as decide is given it (arch 03 line 181), from a K-02 context fixture. */
export function contextText(caseName) {
  const context = contractJson(CASES[caseName].context);
  const person = context.writer.people[0];
  const roles = person.roles.map((r) => `${r.role} of ${r.businessId}`).join(", ");
  return [
    `<who>${person.name}, ${roles}; language ${person.language ?? context.businessLanguage}</who>`,
    "<open_questions>",
    ...context.openQuestions.map(
      (q) => `${q.openQuestionId} (step ${q.step}, ${q.target.businessName}, asked ${q.askCount} time)`,
    ),
    "</open_questions>",
    "<choices>",
    ...context.choices.map(choiceLine),
    "</choices>",
    "<facts>",
    ...context.facts.map(
      (f) => `${f.name}: ${typeof f.value === "string" ? f.value : JSON.stringify(f.value)}`,
    ),
    "</facts>",
    "<recent_messages>",
    ...context.recentMessages.map((m) => `${m.from}: ${m.words}`),
    "</recent_messages>",
    `<turn>${context.texts.map((t) => t.words).join("\n")}</turn>`,
  ].join("\n");
}

const COMMON =
  "You read one turn of texts to a booking assistant and map each part of it to one verb. Use only the choices listed, by their ids; for choose, give the choice's question as listed. Quote each part's exact words, and give each field's value with the exact words it comes from.";

function verbList() {
  const model = contractJson(MODEL_SCHEMA);
  return VERBS.map(({ verb, def }) => `- ${verb}: ${model.$defs[def].description}`).join("\n");
}

export function systemPrompt(candidate) {
  if (isTools(candidate)) {
    return `${COMMON} For each part, call exactly one tool: the one whose verb fits that part. Make all the calls in one response, in the order the parts appear in the text, and give the text's language (two letters) in every call.${candidate === "tools-flat" ? " Write each field's value as text with its type." : ""}`;
  }
  if (candidate === "envelope") {
    return `${COMMON} Return one entry per part, in the text's order. Fill only what the part's verb uses and leave the rest empty ("" or []), with about "none" unless the verb is hand_off. Write each field's value as text with its type. The verbs:\n${verbList()}`;
  }
  if (candidate === "two-step") {
    return `You read one turn of texts to a booking assistant. Split it into parts and give each part's exact words and the one verb that fits it, in the text's order, with the text's language. Do not give fields yet. The verbs:\n${verbList()}`;
  }
  if (candidate === "two-step-2") {
    return `${COMMON} The part and its verb are already chosen; give only what that verb needs for that part.`;
  }
  throw new Error(`unknown candidate ${candidate}`);
}

// ---------------------------------------------------------------------------------------------------------
// The requests.

function baseBody(model, system, user) {
  return {
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: "user", content: user }],
  };
}

export function requestBody(candidate, model, caseName) {
  const user = contextText(caseName);
  if (isTools(candidate)) {
    return {
      ...baseBody(model, systemPrompt(candidate), user),
      tools: decideTools({ flat: candidate === "tools-flat" }),
      // Forced tool use ("any", "tool") is a 400 on claude-sonnet-5-5 (claude-api skill, tool-use-concepts.md);
      // auto is sent on both models so the gateway has one shape.
      tool_choice: { type: "auto" },
      output_config: { effort: "low" },
    };
  }
  if (candidate === "envelope" || candidate === "two-step") {
    const schema = candidate === "envelope" ? envelopeSchema() : stage1Schema();
    return {
      ...baseBody(model, systemPrompt(candidate), user),
      output_config: { effort: "low", format: { type: "json_schema", schema } },
    };
  }
  throw new Error(`unknown candidate ${candidate}`);
}

/** (c) The stage-2 request for one part that stage 1 returned. */
export function stage2Body(model, caseName, part) {
  const schema = stage2Schema(part.verb);
  if (schema === null) throw new Error("no_op has no stage 2");
  const user = `${contextText(caseName)}\n<part>verb ${part.verb}; quote: ${part.quote}</part>`;
  return {
    ...baseBody(model, systemPrompt("two-step-2"), user),
    output_config: { effort: "low", format: { type: "json_schema", schema } },
  };
}

function buildCall(n, candidate, model, caseName) {
  return {
    n,
    id: `${candidate}${candidate === "two-step" ? "-1" : ""}-${caseName}-${model.replace(/^claude-/, "")}`,
    candidate,
    stage: candidate === "two-step" ? 1 : null,
    model,
    caseName,
    body: requestBody(candidate, model, caseName),
  };
}

/**
 * The first round: every candidate on claude-haiku-5-5 with the two-requests case (two parts, a money field: the
 * hardest fixture). The two-step read's stage-2 calls (one per part that needs one, at most MAX_STAGE2) follow its
 * stage 1 at run time.
 */
export function buildCalls() {
  return CANDIDATES.map((candidate, k) => buildCall(k + 1, candidate, MODELS[0], "two-requests"));
}

/** How many one-call candidates the second round takes. */
export const FOLLOW_UPS = 2;

/**
 * Picks the strongest one-call candidates from the first round's lines, in ONE_CALL's order: those accepted with a
 * mapped read valid against decideRead first, then those accepted; at most FOLLOW_UPS.
 */
export function chooseStrongest(lines) {
  const first = (candidate) => lines.find((line) => line.candidate === candidate && line.model === MODELS[0]);
  const valid = ONE_CALL.filter((c) => first(c)?.accepted === true && first(c)?.mapped_valid === true);
  const accepted = ONE_CALL.filter((c) => first(c)?.accepted === true && !valid.includes(c));
  return [...valid, ...accepted].slice(0, FOLLOW_UPS);
}

/** The second round: each chosen candidate on claude-sonnet-5-5 (two-requests), then on Haiku with S1-02. */
export function buildFollowUps(chosen, firstN = CANDIDATES.length + 1) {
  const calls = [];
  for (const candidate of chosen) calls.push([candidate, MODELS[1], "two-requests"]);
  for (const candidate of chosen) calls.push([candidate, MODELS[0], "s1-02"]);
  return calls.map(([candidate, model, caseName], k) => buildCall(firstN + k, candidate, model, caseName));
}

/** (c) The stage-2 calls for a stage-1 output: one per part except no_op, at most MAX_STAGE2. */
export function buildStage2Calls(head, stage1Output) {
  const calls = [];
  (stage1Output?.parts ?? []).forEach((part, k) => {
    if (part.verb === "no_op" || calls.length >= MAX_STAGE2) return;
    calls.push({
      n: `${head.n}.${k + 1}`,
      id: `two-step-2-p${k + 1}-${head.caseName}-${head.model.replace(/^claude-/, "")}`,
      candidate: "two-step",
      stage: 2,
      partIndex: k,
      verb: part.verb,
      model: head.model,
      caseName: head.caseName,
      body: stage2Body(head.model, head.caseName, part),
    });
  });
  return calls;
}

// ---------------------------------------------------------------------------------------------------------
// What came back.

/** The parsed JSON of a response's first text block, or undefined. */
export function outputOf(response) {
  const block = Array.isArray(response?.content)
    ? response.content.find((item) => item?.type === "text")
    : undefined;
  if (block === undefined) return undefined;
  try {
    return JSON.parse(block.text);
  } catch {
    return undefined;
  }
}

/** Ajv's errors as short lines. */
const errorLines = (validate) =>
  (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`);

/**
 * Checks one call's answer against its wire schema: the tool inputs (a), the envelope (b), stage 1 or a stage 2 (c).
 * @returns {{ valid: boolean | null, errors: string[] | null, output: unknown }}
 */
export function checkWire(call, response, wire) {
  if (isTools(call.candidate)) {
    const blocks = (response?.content ?? []).filter((block) => block?.type === "tool_use");
    if (blocks.length === 0) return { valid: false, errors: ["no tool call"], output: blocks };
    const errors = [];
    const prefix = call.candidate === "tools-flat" ? "tool-flat" : "tool";
    for (const block of blocks) {
      const validate = wire[`${prefix}:${block.name}`];
      if (validate === undefined) errors.push(`unknown tool ${block.name}`);
      else if (validate(block.input) !== true)
        errors.push(...errorLines(validate).map((e) => `${block.name} ${e}`));
    }
    return { valid: errors.length === 0, errors: errors.length === 0 ? null : errors, output: blocks };
  }
  const output = outputOf(response);
  const key =
    call.candidate === "envelope" ? "envelope" : call.stage === 1 ? "stage1" : `stage2:${call.verb}`;
  const validate = wire[key];
  if (output === undefined || validate === undefined) {
    return {
      valid: false,
      errors: [output === undefined ? "no JSON text block" : `no schema ${key}`],
      output,
    };
  }
  const valid = validate(output) === true;
  return { valid, errors: valid ? null : errorLines(validate), output };
}

/** Maps a candidate's answer into a decideRead and validates it against the frozen decideRead. */
export function mapAndValidate(candidate, answer, decideRead) {
  const mapped = isTools(candidate)
    ? mapToolBlocks(answer, { flat: candidate === "tools-flat" })
    : candidate === "envelope"
      ? mapEnvelope(answer)
      : mapTwoStep(answer.stage1, answer.stage2);
  if (mapped.read === undefined)
    return { read: undefined, mappingErrors: mapped.errors, valid: false, errors: null };
  const valid = decideRead(mapped.read) === true;
  return {
    read: mapped.read,
    mappingErrors: mapped.errors,
    valid: valid && mapped.errors.length === 0,
    errors: valid ? null : errorLines(decideRead),
  };
}

/** One results.jsonl line. Never takes or returns a header. */
export function resultLine(call, { status, response, error, elapsedMs }, checks = {}) {
  const accepted = status === 200;
  let refusal = null;
  if (!accepted) refusal = response?.error?.message ?? error ?? `HTTP ${status}`;
  else if (response?.stop_reason === "refusal") refusal = response?.stop_details ?? "stop_reason refusal";
  return {
    n: call.n,
    id: call.id,
    candidate: call.candidate,
    stage: call.stage,
    model: call.model,
    case: call.caseName,
    http_status: status,
    accepted,
    stop_reason: response?.stop_reason ?? null,
    refusal_or_error: refusal,
    tool_calls: Array.isArray(response?.content)
      ? response.content.filter((block) => block?.type === "tool_use").length
      : null,
    wire_valid: checks.wireValid ?? null,
    wire_errors: checks.wireErrors ?? null,
    mapped_valid: checks.mappedValid ?? null,
    mapped_errors: checks.mappedErrors ?? null,
    mapping_errors: checks.mappingErrors ?? null,
    same_as_fixture: checks.sameAsFixture ?? null,
    input_tokens: response?.usage?.input_tokens ?? null,
    output_tokens: response?.usage?.output_tokens ?? null,
    elapsed_ms: elapsedMs,
  };
}
