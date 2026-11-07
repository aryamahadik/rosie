// T-360 spike: what probe.mjs sends and how it checks it, kept free of network and keys so it can be tested
// offline. ES module; uses only ajv from the root manifest and Node 22 built-ins.
//
// The candidate schemas in schemas/ are spike candidates, not the contracts (K-02 is T-011's, K-03 is T-012's).
// They refer to contracts/common/formats.v1.schema.json with a relative $ref, the way the contracts will. The
// Messages API refuses an external $ref, so bundleForModel() copies the formats a schema uses into its own $defs
// before it is sent.

import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";

export const API_URL = "https://api.anthropic.com/v1/messages";
export const API_VERSION = "2026-10-21";
export const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"];
export const MAX_CALLS = 20;
export const MAX_TOKENS = 4096;

const HERE = new URL("./", import.meta.url);
const SCHEMAS = new URL("schemas/", HERE);
const FORMATS_URL = new URL("../../../contracts/common/formats.v1.schema.json", HERE);
const FORMATS_REF = /(?:^|\/)formats\.v1\.schema\.json#\/\$defs\/([A-Za-z0-9_]+)$/;

export const CANDIDATES = ["decide", "safety-read", "planner", "message-plan"];

export function readJson(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}

export function loadCandidate(name) {
  return readJson(new URL(`${name}.candidate.schema.json`, SCHEMAS));
}

export function loadFormats() {
  return readJson(FORMATS_URL);
}

const clone = (value) => structuredClone(value);

function walk(node, visit) {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  if (node === null || typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node)) walk(value, visit);
}

/**
 * Returns a copy of `schema` that the Messages API can take: every $ref to formats.v1 points at a copy of that
 * format in the schema's own $defs (named formats_<name>, with the formats it uses in turn), and, unless
 * keepHeader is set, $schema and $id are left out.
 */
export function bundleForModel(schema, formats, { keepHeader = false } = {}) {
  const out = clone(schema);
  if (!keepHeader) {
    delete out.$schema;
    delete out.$id;
  }
  out.$defs = out.$defs ?? {};
  const pending = [];
  const rewrite = (node) => {
    if (typeof node.$ref !== "string") return;
    const match = FORMATS_REF.exec(node.$ref);
    const local = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(node.$ref);
    const name = match?.[1];
    if (name !== undefined) {
      node.$ref = `#/$defs/formats_${name}`;
      pending.push(name);
    } else if (local !== null && node.__fromFormats === true) {
      node.$ref = `#/$defs/formats_${local[1]}`;
      pending.push(local[1]);
    }
    delete node.__fromFormats;
  };
  walk(out, rewrite);
  while (pending.length > 0) {
    const name = pending.shift();
    const key = `formats_${name}`;
    if (key in out.$defs) continue;
    const def = formats.$defs?.[name];
    if (def === undefined) throw new Error(`formats.v1 has no $defs/${name}`);
    const copy = clone(def);
    // Refs inside a format are local to formats.v1 ("#/$defs/currency"); mark them, then rewrite them.
    walk(copy, (node) => {
      if (typeof node.$ref === "string" && node.$ref.startsWith("#/$defs/")) node.__fromFormats = true;
    });
    walk(copy, rewrite);
    out.$defs[key] = copy;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// The structured-outputs subset (Anthropic, "Structured outputs", read 2026-11-07; ops/plan/02-contracts.md
// section 2 item 7; contracts/README.md convention 7). checkSubset() lists what a schema uses outside it, so
// the same check can run on a contract before anyone spends a call.

const NUMBER_LIMITS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"];
const STRING_LIMITS = ["minLength", "maxLength"];
const ARRAY_LIMITS = ["maxItems", "uniqueItems", "contains", "minContains", "maxContains", "prefixItems"];
const OTHER_UNSUPPORTED = [
  "patternProperties",
  "propertyNames",
  "dependentRequired",
  "dependentSchemas",
  "if",
];
export const LIMITS = { optionalProperties: 24, unionParameters: 16 };

function localRefTarget(ref) {
  const match = /^#\/\$defs\/([^/]+)$/.exec(ref);
  return match === null ? undefined : match[1];
}

/** @returns {{ problems: string[], optionalProperties: number, unionParameters: number }} */
export function checkSubset(schema) {
  const problems = [];
  let optionalProperties = 0;
  let unionParameters = 0;
  const visit = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((child, k) => visit(child, `${path}/${k}`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const key of [...NUMBER_LIMITS, ...STRING_LIMITS, ...ARRAY_LIMITS, ...OTHER_UNSUPPORTED]) {
      if (key in node) problems.push(`${path}: ${key} is outside the subset`);
    }
    if ("minItems" in node && node.minItems !== 0 && node.minItems !== 1) {
      problems.push(`${path}: minItems ${node.minItems} (only 0 or 1)`);
    }
    if (typeof node.$ref === "string" && !node.$ref.startsWith("#")) {
      problems.push(`${path}: external $ref ${node.$ref}`);
    }
    const isObject = node.type === "object" || (node.properties !== undefined && node.type === undefined);
    if (isObject && node.additionalProperties !== false) {
      problems.push(`${path}: an object needs additionalProperties false`);
    }
    if (node.properties !== undefined) {
      const required = new Set(node.required ?? []);
      optionalProperties += Object.keys(node.properties).filter((name) => !required.has(name)).length;
    }
    if (Array.isArray(node.anyOf) || Array.isArray(node.type)) unionParameters += 1;
    if (Array.isArray(node.enum) && node.enum.some((value) => value !== null && typeof value === "object")) {
      problems.push(`${path}: enum holds a complex value`);
    }
    for (const [key, value] of Object.entries(node)) visit(value, `${path}/${key}`);
  };
  visit(schema, "#");

  // Recursion: a $defs entry that reaches itself through local $refs.
  const defs = schema.$defs ?? {};
  const edges = new Map();
  for (const [name, def] of Object.entries(defs)) {
    const targets = new Set();
    walk(def, (node) => {
      if (typeof node.$ref === "string") {
        const target = localRefTarget(node.$ref);
        if (target !== undefined) targets.add(target);
      }
    });
    edges.set(name, targets);
  }
  const reaches = (from, to, seen = new Set()) => {
    for (const next of edges.get(from) ?? []) {
      if (next === to) return true;
      if (!seen.has(next)) {
        seen.add(next);
        if (reaches(next, to, seen)) return true;
      }
    }
    return false;
  };
  for (const name of edges.keys()) if (reaches(name, name)) problems.push(`#/$defs/${name}: recursive`);

  if (optionalProperties > LIMITS.optionalProperties) {
    problems.push(`${optionalProperties} optional properties (limit ${LIMITS.optionalProperties})`);
  }
  if (unionParameters > LIMITS.unionParameters) {
    problems.push(`${unionParameters} union parameters (limit ${LIMITS.unionParameters})`);
  }
  return { problems, optionalProperties, unionParameters };
}

// ---------------------------------------------------------------------------------------------------------
// Validation (contracts/README.md convention 8: Ajv 8, 2020-12, strict).

export function createAjv() {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  ajv.addSchema(loadFormats());
  return ajv;
}

/** Compiles each candidate (with its contract-style relative $ref) and returns a validator per name. */
export function compileCandidates(ajv = createAjv()) {
  return Object.fromEntries(CANDIDATES.map((name) => [name, ajv.compile(loadCandidate(name))]));
}

// ---------------------------------------------------------------------------------------------------------
// The prompts. Only made-up values and fixture set v1's demo shop "Flooring installer"
// (fixtures/v1/test-kit/shops/flooring.json: staff Elena and Leo, the $35 floor consult, the $20 missed-consult
// fee, 123 Demo St, Anytown) and the architecture's own example lines (hard rule 9: no real customer data).

const PROMPTS = {
  control: {
    system: "Answer in the JSON shape given.",
    user: "Is the sky usually blue on a clear day?",
  },
  decide: {
    system:
      "You read one turn of texts to a booking assistant and map each part of it to one verb. Use only the choices listed. Quote each part's exact words.",
    user: [
      "<who>The owner of Flooring installer (demo shop), writing from the owner's phone.</who>",
      "<choices>",
      "door-block-time (door): Owner command: block time off the calendar.",
      "door-price-change (door): Owner command: change a service's price.",
      "any-stop (anytime_row): The sender asks Rosie to stop texting.",
      "q-1 (open question: 'Which day works for your floor consult?'): options opt-tue (Tuesday), opt-wed (Wednesday).",
      "</choices>",
      "<turn>block thursday afternoon and also tile is $12 a foot</turn>",
    ].join("\n"),
  },
  "safety-read": {
    system:
      "You read one raw text for safety before anything else happens. Label it with every outcome that applies, each with its tense, the words that support it, who is at risk and who wrote it.",
    user: "<text>the gas leak was fixed in March, can we book the floor consult for next week?</text>",
  },
  planner: {
    system:
      "Nothing on the list fit this turn. Choose exactly one of your five verbs. You never book, charge, refund, cancel, move, or change a setting, contact or consent.",
    user: [
      "<facts>",
      "business.address: 123 Demo St, Anytown (demo)",
      "business.hours: Mon-Fri 9am-5pm, Sat 10am-2pm",
      "</facts>",
      "<turn>is there parking at the showroom?</turn>",
    ].join("\n"),
  },
  "message-plan": {
    system:
      "You plan one text message for a booking assistant. Write values only as {{slot}} tokens from the facts given; never type a number, time, price or name yourself. One question at most.",
    user: [
      "<conversation></conversation>",
      "<master_text>Confirm the floor consult: what, when, where and the price; say the missed-consult fee; link to the secure page to manage it.</master_text>",
      "<facts>svc.intext, name.staff, day, arrive, price, fee, secure_link</facts>",
      "<audience>customer</audience>",
      "<language>en</language>",
      "<channel>imessage</channel>",
      "<situation>money_or_consent</situation>",
      "<allowed_formats>text, link_card</allowed_formats>",
      "<allowed_links>secure_link</allowed_links>",
    ].join("\n"),
  },
};

const CONTROL_SCHEMA = {
  type: "object",
  properties: { answer: { type: "boolean" } },
  required: ["answer"],
  additionalProperties: false,
};

export function requestBody(model, schema, prompt) {
  return {
    model,
    max_tokens: MAX_TOKENS,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
    output_config: { effort: "low", format: { type: "json_schema", schema } },
  };
}

// Negative controls: schemas outside the subset, sent once on Haiku to record the API's refusal text.
function negatives(formats) {
  const planner = bundleForModel(loadCandidate("planner"), formats);
  const stringLimit = clone(planner);
  stringLimit.$defs.askOne.properties.unclear.maxLength = 200;
  const numberLimit = clone(planner);
  numberLimit.properties.score = { type: "integer", minimum: 0, maximum: 100 };
  numberLimit.required = [...numberLimit.required, "score"];
  const openObject = clone(planner);
  openObject.additionalProperties = true;
  const unbundled = loadCandidate("decide");
  return [
    { id: "neg-string-length", schema: stringLimit, prompt: "planner", what: "maxLength on a string" },
    {
      id: "neg-number-limit",
      schema: numberLimit,
      prompt: "planner",
      what: "minimum and maximum on an integer",
    },
    { id: "neg-open-object", schema: openObject, prompt: "planner", what: "additionalProperties true" },
    {
      id: "neg-external-ref",
      schema: unbundled,
      prompt: "decide",
      what: "decide as the contract file will be written: relative $ref to formats.v1, $schema and $id kept",
    },
  ];
}

/**
 * Every call the probe may make, in order. Each model's control call goes first; if it is not accepted, the
 * probe skips the rest of that model's calls (a request-shape problem, not a schema finding).
 * @returns {{ n: number, id: string, model: string, schemaName: string, variant: string, expect: string,
 *   what: string, body: object }[]}
 */
export function buildCalls(formats = loadFormats()) {
  const calls = [];
  const add = (call) => calls.push({ n: calls.length + 1, ...call });
  for (const model of MODELS) {
    const short = model.replace(/^claude-/, "");
    add({
      id: `control-${short}`,
      model,
      schemaName: "control",
      variant: "control",
      expect: "accept",
      what: "a one-field schema: proves the request shape before any candidate is spent",
      body: requestBody(model, CONTROL_SCHEMA, PROMPTS.control),
    });
    for (const name of CANDIDATES) {
      add({
        id: `${name}-${short}`,
        model,
        schemaName: name,
        variant: "bundled",
        expect: "accept",
        what: "the candidate with formats.v1 copied into its $defs, $schema and $id left out",
        body: requestBody(model, bundleForModel(loadCandidate(name), formats), PROMPTS[name]),
      });
    }
    add({
      id: `decide-header-${short}`,
      model,
      schemaName: "decide",
      variant: "bundled-with-header",
      expect: "unknown",
      what: "the bundled decide candidate keeping $schema and $id",
      body: requestBody(
        model,
        bundleForModel(loadCandidate("decide"), formats, { keepHeader: true }),
        PROMPTS.decide,
      ),
    });
  }
  const haiku = MODELS[0];
  for (const negative of negatives(formats)) {
    add({
      id: negative.id,
      model: haiku,
      schemaName: negative.prompt,
      variant: "negative",
      expect: "refuse",
      what: negative.what,
      body: requestBody(haiku, negative.schema, PROMPTS[negative.prompt]),
    });
  }
  return calls;
}

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

/** One results.jsonl line for a call and what came back. Never takes or returns a header. */
export function resultLine(call, { status, response, error, elapsedMs, validators }) {
  const accepted = status === 200;
  const output = accepted ? outputOf(response) : undefined;
  const validate = call.variant === "negative" ? undefined : validators?.[call.schemaName];
  let outputValid = null;
  let outputErrors = null;
  if (accepted && validate !== undefined) {
    outputValid = output !== undefined && validate(output) === true;
    outputErrors = outputValid ? null : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
  }
  let refusal = null;
  if (!accepted) refusal = response?.error?.message ?? error ?? `HTTP ${status}`;
  else if (response?.stop_reason === "refusal") refusal = response?.stop_details ?? "stop_reason refusal";
  return {
    n: call.n,
    id: call.id,
    schema: call.schemaName,
    variant: call.variant,
    model: call.model,
    expect: call.expect,
    http_status: status,
    accepted,
    stop_reason: response?.stop_reason ?? null,
    refusal_or_error: refusal,
    output_valid: outputValid,
    output_errors: outputErrors,
    input_tokens: response?.usage?.input_tokens ?? null,
    output_tokens: response?.usage?.output_tokens ?? null,
    elapsed_ms: elapsedMs,
  };
}
