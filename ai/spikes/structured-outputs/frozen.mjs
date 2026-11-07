// T-1066: the frozen model-facing schemas, sent the way the AI gateway will send them. Kept free of network and keys
// so it can be tested offline. ES module; uses ajv (through the contracts' helpers) and Node 22 built-ins.
//
// The four schemas are the frozen contracts' own, not spike candidates: K-02's decide read, safety read and
// planner output (contracts/model/model.v1.schema.json) and K-03's plan (contracts/message-plan/
// message-plan.v1.schema.json). Each is produced by bundleSchema() from contracts/scripts/structured-subset-lint.mjs
// (every $ref resolved into the schema's own $defs, $schema and $id left out), the form the lint checks and the
// gateway will send. This module reads the contract files and never changes them.

import path from "node:path";
import { CONTRACTS_DIR, createAjv, idFor, readJson } from "../../../contracts/scripts/lib.mjs";
import { MODEL_FACING, bundleSchema } from "../../../contracts/scripts/structured-subset-lint.mjs";
import { MAX_CALLS, MODELS, requestBody } from "./lib.mjs";

/** The one model the frozen check uses (T-360 already measured both on the candidates). */
export const FROZEN_MODEL = MODELS[0];

const PLAN_TARGET = Object.freeze({
  schema: "message-plan/message-plan.v1.schema.json",
  def: "plan",
  what: "K-03 plan (arch 07 line 397)",
});

/** The four frozen model-facing schemas: K-02's three (MODEL_FACING) and K-03's plan. */
export const FROZEN_TARGETS = Object.freeze([
  ...MODEL_FACING.filter((target) => target.schema.startsWith("model/")),
  PLAN_TARGET,
]);

/** Exactly this many calls: the 20-call limit less the 16 T-360 used. */
export const FROZEN_CALLS = 4;

const CONTRACT_FILES = [
  "common/formats.v1.schema.json",
  "bundle/bundle.v1.schema.json",
  "model/model.v1.schema.json",
  "message-plan/message-plan.v1.schema.json",
];

const fixture = (file) => readJson(path.join(CONTRACTS_DIR, file), file);

/** The bundled schema the gateway would send for one target. */
export function frozenSchema(target) {
  return bundleSchema({ schema: target.schema, def: target.def });
}

/**
 * A validator per target (keyed by def), compiled from the contract files themselves with Ajv 2020 strict: the
 * frozen def, with the shared formats and the bundle schema loaded.
 */
export function compileFrozen() {
  const ajv = createAjv();
  for (const file of CONTRACT_FILES) ajv.addSchema(fixture(file));
  return Object.fromEntries(
    FROZEN_TARGETS.map((target) => {
      const validate = ajv.getSchema(`${idFor(target.schema)}#/$defs/${target.def}`);
      if (validate === undefined) throw new Error(`${target.schema}#/$defs/${target.def} did not compile`);
      return [target.def, validate];
    }),
  );
}

/** A valid output for each target, taken from the frozen contract's own fixtures (never a real text). */
export function frozenSamples() {
  return {
    decideRead: fixture("model/fixtures/decide-s1-02-choose.json").reads[0].output,
    safetyRead: fixture("model/fixtures/safety-over-gas-leak.json").read,
    plannerOutput: fixture("model/fixtures/planner-answer.json"),
    plan: fixture("message-plan/fixtures/plan-s1-02.json"),
  };
}

// ---------------------------------------------------------------------------------------------------------
// The prompts: short, built from the frozen fixtures, so every name and value is the fixtures' own (Sam Lee,
// Lee's Barbershop and the rest are the contract fixtures' made-up cast; hard rule 9).

function decidePrompt() {
  const context = fixture("model/fixtures/context-s1-02.json");
  const person = context.writer.people[0];
  const roles = person.roles.map((r) => `${r.role} of ${r.businessId}`).join(", ");
  const choices = context.choices.map((c) => {
    const kind = [
      c.kind,
      c.question ? `answers ${c.question}` : null,
      c.door ? `door ${c.door}` : null,
      c.anytimeRow ? `any-time row ${c.anytimeRow}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const fields =
      c.fields.length > 0 ? ` Fields: ${c.fields.map((f) => `${f.name} (${f.type})`).join(", ")}.` : "";
    return `${c.choiceId} (${kind}): ${c.label}. ${c.definition}${fields}`;
  });
  const open = context.openQuestions.map(
    (q) => `${q.openQuestionId} (step ${q.step}, ${q.target.businessName}, asked ${q.askCount} time)`,
  );
  const recent = context.recentMessages.map((m) => `${m.from}: ${m.words}`);
  return {
    system:
      "You read one turn of texts to a booking assistant and map each part of it to one verb. Use only the choices listed, by their ids. Quote each part's exact words.",
    user: [
      `<who>${person.name}, ${roles}, language ${person.language}</who>`,
      "<open_questions>",
      ...open,
      "</open_questions>",
      "<choices>",
      ...choices,
      "</choices>",
      "<recent_messages>",
      ...recent,
      "</recent_messages>",
      `<turn>${context.texts.map((t) => t.words).join("\n")}</turn>`,
    ].join("\n"),
  };
}

function safetyPrompt() {
  const fixtureRead = fixture("model/fixtures/safety-over-gas-leak.json");
  return {
    system:
      "You read one raw text for safety before anything else happens. Label it with every outcome that applies, each with its tense, the words that support it, who is at risk and who wrote it.",
    user: `<text>${fixtureRead.read.labels[0].evidence}</text>`,
  };
}

function plannerPrompt() {
  const answer = fixture("model/fixtures/planner-answer.json");
  const factLines = answer.action.facts.map((slot) => `${slot}: ${answer.action.text}`);
  return {
    system:
      "Nothing on the list fit this turn. Choose exactly one of your five verbs. You never book, charge, refund, cancel, move, or change a setting, contact or consent.",
    user: [
      "<facts>",
      ...factLines,
      "</facts>",
      "<turn>what is the fee if I miss my visit?</turn>",
      `<language>${answer.language}</language>`,
    ].join("\n"),
  };
}

function planPrompt() {
  const input = fixture("message-plan/fixtures/input-s1-02.json");
  const tag = (name, value) => `<${name}>${value}</${name}>`;
  return {
    system:
      "You plan one text message for a booking assistant. Write values only as {{slot}} tokens from the facts given; never type a number, time, price or name yourself. One question at most.",
    user: [
      tag("conversation", input.conversation.map((m) => `${m.from}: ${m.text}`).join("\n")),
      tag("master_text", `${input.masterText.step}: ${input.masterText.text}`),
      tag("facts", input.facts.map((f) => `${f.slot}: ${f.value}`).join("\n")),
      tag("audience", JSON.stringify(input.audience)),
      tag("language", input.language),
      tag("channel", input.channel),
      tag("situation", input.situation),
      tag("allowed_formats", input.allowedFormats.join(", ")),
      tag("allowed_links", input.allowedLinks.join(", ")),
      tag("options", input.options.map((o) => `${o.id}: ${o.label}`).join("\n")),
      tag("page_types", input.pageTypes.join(", ")),
      tag("open_questions", input.openQuestions.map((q) => `${q.id}: ${q.text}`).join("\n")),
      tag("inbound", input.inbound === null ? "" : input.inbound.text),
    ].join("\n"),
  };
}

const PROMPTS = {
  decideRead: { id: "frozen-decide-read", build: decidePrompt },
  safetyRead: { id: "frozen-safety-read", build: safetyPrompt },
  plannerOutput: { id: "frozen-planner-output", build: plannerPrompt },
  plan: { id: "frozen-plan", build: planPrompt },
};

/**
 * The frozen run's calls: one per target, in order, all on FROZEN_MODEL, numbered from firstN (the number after the
 * calls results.jsonl already logs). Same shape as lib.mjs buildCalls(), so probe.mjs sends and logs them the same way.
 * @returns {{ n: number, id: string, model: string, schemaName: string, variant: string, expect: string,
 *   what: string, body: object }[]}
 */
export function buildFrozenCalls({ firstN = MAX_CALLS - FROZEN_CALLS + 1 } = {}) {
  const short = FROZEN_MODEL.replace(/^claude-/, "");
  return FROZEN_TARGETS.map((target, k) => {
    const prompt = PROMPTS[target.def];
    return {
      n: firstN + k,
      id: `${prompt.id}-${short}`,
      model: FROZEN_MODEL,
      schemaName: target.def,
      variant: "frozen",
      expect: target.def === "decideRead" ? "unknown" : "accept",
      what: `${target.what}: ${target.schema}#/$defs/${target.def} as bundleSchema() builds it`,
      body: requestBody(FROZEN_MODEL, frozenSchema(target), prompt.build()),
    };
  });
}
