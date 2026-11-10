// T-1165: compose input's check (check.ts) in Node, with Ajv's compiler and the Tool API validator's strict options, on
// the frozen K-03 files it reads from disk: exactly the files K-03 v1's and v1.1's composeInput reach. It gives the
// answers the build recorded from Ajv's compiler (compose-input-answers.js), which the Worker's prebuilt code is held to
// (check.worker.test.ts), under each version; K-03 v1.1 is the version compose input checks since T-1174 (DL-355,
// DL-357), and every v1 input gets the same answer under v1.1. Values come only from the contracts' fixtures (rule 9).

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ajvAnswers, type AjvCheck } from "../tool-api/generated/compose-input-answers";
import { contractFile } from "../tool-api/test-support";
import { CONTRACTS_DIR, formatProblems, loadToolApiSchemas } from "../tool-api/validator";
import {
  COMPOSE_INPUT_SCHEMA_FILES,
  COMPOSE_INPUT_SCHEMA_IDS,
  MESSAGE_PLAN_SCHEMA_ID,
  MESSAGE_PLAN_V1_1_SCHEMA_ID,
  createComposeInputChecker,
  defaultComposeInputChecker,
  loadComposeInputSchemas,
  type ComposeInputChecker,
  type ComposeInputSchemaId,
} from "./check";
import { k03Fixture } from "./test-support";

type Json = Record<string, unknown>;

/** A checker for each K-03 version, by the $ref of its composeInput. */
const checkers = new Map<string, ComposeInputChecker>(
  COMPOSE_INPUT_SCHEMA_IDS.map((schemaId) => [
    `${schemaId}#/$defs/composeInput`,
    createComposeInputChecker(undefined, schemaId),
  ]),
);

/** The checker made for K-03 `schemaId`. */
function checkerFor(schemaId: ComposeInputSchemaId): ComposeInputChecker {
  const checker = checkers.get(`${schemaId}#/$defs/composeInput`);
  if (checker === undefined) throw new Error(`no checker for ${schemaId}`);
  return checker;
}

/** The value a recorded check reads: the fixture's value at its path, or {}. */
function valueOf(check: AjvCheck): unknown {
  let value: unknown = check.source === null ? {} : ajvAnswers.fixtures[check.source];
  for (const key of check.at) value = (value as Record<string | number, unknown>)[key];
  return value;
}

/** Every file a schema's $refs name, relative to contracts/ (K-03's $refs are relative paths). */
function referencedFiles(file: string): string[] {
  const refs: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (typeof value === "object" && value !== null) {
      for (const [key, inner] of Object.entries(value)) {
        if (key === "$ref" && typeof inner === "string") refs.push(inner);
        else walk(inner);
      }
    }
  };
  walk(JSON.parse(readFileSync(path.join(CONTRACTS_DIR, ...file.split("/")), "utf8")));
  return refs
    .map((ref) => ref.split("#")[0] ?? "")
    .filter((target) => target !== "")
    .map((target) => path.posix.join(path.posix.dirname(file), target));
}

/** Every file the $refs of `roots` reach, relative to contracts/, sorted. */
function closureOf(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift() ?? "";
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...referencedFiles(file));
  }
  return [...seen].sort();
}

/** input-s1-02.json with a conversation of `count` messages, each Sam's text as its <inbound> gives it. */
function withConversation(count: number): Json {
  const input = k03Fixture("input-s1-02.json") as Json & { inbound: { text: string; sentAt: unknown } };
  const message = { from: "reader", text: input.inbound.text, sentAt: input.inbound.sentAt };
  input.conversation = Array.from({ length: count }, () => structuredClone(message));
  return input;
}

describe("compose input checks K-03 v1.1's composeInput, and v1's for a checker made for it", () => {
  it("reads K-03 v1's and v1.1's $ids, in that order, each with its composeInput", () => {
    const v1 = contractFile("message-plan/message-plan.v1.schema.json") as { $id: string; $defs: Json };
    const v11 = contractFile("message-plan/message-plan.v1.1.schema.json") as { $id: string; $defs: Json };
    expect(MESSAGE_PLAN_SCHEMA_ID).toBe(v1.$id);
    expect(MESSAGE_PLAN_V1_1_SCHEMA_ID).toBe(v11.$id);
    expect([...COMPOSE_INPUT_SCHEMA_IDS]).toEqual([v1.$id, v11.$id]);
    expect(v1.$defs.composeInput).toBeDefined();
    expect(v11.$defs.composeInput).toBeDefined();
  });

  it("holds exactly the files K-03 v1's and v1.1's $refs reach, read from disk", () => {
    const reached = closureOf([
      "message-plan/message-plan.v1.schema.json",
      "message-plan/message-plan.v1.1.schema.json",
    ]);
    expect([...COMPOSE_INPUT_SCHEMA_FILES].sort()).toEqual(reached);
    const ids = loadComposeInputSchemas().map((schema) => (schema as { $id: string }).$id);
    expect(ids).toHaveLength(COMPOSE_INPUT_SCHEMA_FILES.length);
    expect(ids).toEqual(expect.arrayContaining([...COMPOSE_INPUT_SCHEMA_IDS]));
  });

  it("the shared checker is K-03 v1.1's (T-1174): input-s1-02-v1.1.json's term facts pass, and input-s1-02.json", () => {
    expect(defaultComposeInputChecker().check(k03Fixture("input-s1-02.json"))).toEqual([]);
    expect(defaultComposeInputChecker().check(k03Fixture("input-s1-02-v1.1.json"))).toEqual([]);
    expect(createComposeInputChecker().check(k03Fixture("input-s1-02-v1.1.json"))).toEqual([]);
    // A checker made for v1 still refuses term facts.
    expect(
      createComposeInputChecker(undefined, MESSAGE_PLAN_SCHEMA_ID).check(k03Fixture("input-s1-02-v1.1.json")),
    ).toEqual(checkerFor(MESSAGE_PLAN_SCHEMA_ID).check(k03Fixture("input-s1-02-v1.1.json")));
    expect(checkerFor(MESSAGE_PLAN_SCHEMA_ID).check(k03Fixture("input-s1-02-v1.1.json"))).not.toEqual([]);
  });

  it("a K-03 version it does not check throws, rather than check against a definition the Worker does not hold", () => {
    const v2 = "https://rosie.invalid/contracts/message-plan/message-plan.v2.schema.json";
    expect(() => createComposeInputChecker(undefined, v2 as ComposeInputSchemaId)).toThrow(
      "not a K-03 version whose composeInput compose input checks",
    );
  });

  it("takes the schemas it is given: the Tool API validator's files hold K-03 v1 and, since K-09 v1.6, v1.1", () => {
    const given = createComposeInputChecker(loadToolApiSchemas());
    expect(given.check(k03Fixture("input-s1-02.json"))).toEqual([]);
    expect(given.check(k03Fixture("input-s1-02-v1.1.json"))).toEqual([]);
    expect(given.check(k03Fixture("invalid/refuse-frontier-in-input.json"))).toEqual([
      "(root) must NOT have additional properties (frontier)",
    ]);
    // Given files without K-03 v1.1, the default (v1.1) checker throws rather than check against nothing; v1's checks.
    const withoutV11 = loadToolApiSchemas().filter(
      (schema) => (schema as { $id?: string }).$id !== MESSAGE_PLAN_V1_1_SCHEMA_ID,
    );
    expect(() => createComposeInputChecker(withoutV11).check(k03Fixture("input-s1-02.json"))).toThrow();
    expect(
      createComposeInputChecker(withoutV11, MESSAGE_PLAN_SCHEMA_ID).check(k03Fixture("input-s1-02.json")),
    ).toEqual([]);
  });
});

describe("in Node, each check gives the answer the build recorded from Ajv's compiler, under each version", () => {
  it("the build recorded K-03's inputs under both versions", () => {
    const definitions = new Set(ajvAnswers.checks.map((check) => check.definition));
    expect([...definitions].sort()).toEqual([...checkers.keys()].sort());
    const sources = new Set(ajvAnswers.checks.map((check) => check.source));
    expect(sources).toContain("message-plan/fixtures/input-s1-02-v1.1.json");
    expect(sources).toContain("tool-api/fixtures/compose-input-s1-02.json");
  });

  for (const check of ajvAnswers.checks) {
    it(`${check.source ?? "{}"} /${check.at.join("/")} against ${check.definition}`, () => {
      const checker = checkers.get(check.definition);
      if (checker === undefined) throw new Error(`${check.definition} is not compose input's`);
      expect(checker.check(valueOf(check))).toEqual(formatProblems(check.errors));
    });
  }
});

describe("K-03 v1 and v1.1 on the same inputs", () => {
  it("v1.1 accepts input-s1-02-v1.1.json's term facts; v1 refuses each by its place, never naming its words", () => {
    const input = k03Fixture("input-s1-02-v1.1.json") as { facts: unknown[] };
    expect(input.facts).toHaveLength(4);
    expect(checkerFor(MESSAGE_PLAN_V1_1_SCHEMA_ID).check(input)).toEqual([]);
    const underV1 = checkerFor(MESSAGE_PLAN_SCHEMA_ID).check(input);
    for (const index of [0, 1, 2, 3]) {
      expect(underV1).toContain(`/facts/${String(index)} must have required property 'slot'`);
      expect(underV1).toContain(`/facts/${String(index)} must NOT have additional properties (source)`);
    }
    expect(underV1.join(" ")).not.toContain("$2");
    expect(underV1.join(" ")).not.toContain("15 minutes");
  });

  it("every v1 input gets the same answer under v1.1, the frontier still refused (T-1174's move changes no v1 answer)", () => {
    const exchange = contractFile("tool-api/fixtures/compose-input-s1-02.json") as {
      outcome: { input: Json };
    };
    const inputs: [string, unknown][] = [
      ["input-s1-02.json", k03Fixture("input-s1-02.json")],
      ["refuse-frontier-in-input.json", k03Fixture("invalid/refuse-frontier-in-input.json")],
      ["compose-input-s1-02.json's input", exchange.outcome.input],
      ["{}", {}],
    ];
    for (const [name, value] of inputs) {
      expect(checkerFor(MESSAGE_PLAN_V1_1_SCHEMA_ID).check(value), name).toEqual(
        checkerFor(MESSAGE_PLAN_SCHEMA_ID).check(value),
      );
    }
    expect(checkerFor(MESSAGE_PLAN_V1_1_SCHEMA_ID).check(inputs[1]?.[1])).toEqual([
      "(root) must NOT have additional properties (frontier)",
    ]);
  });

  it("the code check holds under each version: at most 6 messages in <conversation>", () => {
    for (const schemaId of COMPOSE_INPUT_SCHEMA_IDS) {
      expect(checkerFor(schemaId).check(withConversation(6)), schemaId).toEqual([]);
      expect(checkerFor(schemaId).check(withConversation(7)), schemaId).toEqual([
        "/conversation holds more than 6 messages",
      ]);
    }
  });
});
