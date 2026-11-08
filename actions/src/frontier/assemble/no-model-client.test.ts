// T-291: no model client is imported anywhere under actions/src/frontier. The frontier is built by code alone (arch 03
// line 153: "built every turn by code, in milliseconds ... no model involved"); every model call is the AI layer's
// (arch 02 line 137), which the action layer never reaches into. This test reads every source file under the folder,
// tests included, finds each module it imports (static, dynamic or required), and refuses any that names a model SDK or
// a module of the AI layer (ai/, @rosie/ai). A file added later under the folder is scanned the same way.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** actions/src/frontier/ */
const FRONTIER_DIR = fileURLToPath(new URL("../", import.meta.url));
/** The repository's root. */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const CODE_FILE = /\.(?:[cm]?[jt]s|tsx|jsx)$/u;

/** Every code file under `dir`, recursively. */
function codeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return codeFiles(full);
    return CODE_FILE.test(entry.name) ? [full] : [];
  });
}

/** `import ... from "x"`, `export ... from "x"`, `import "x"`, `import("x")` and `require("x")`. */
const SPECIFIERS = [
  /\bfrom\s*["'`]([^"'`]+)["'`]/gu,
  /\bimport\s*["'`]([^"'`]+)["'`]/gu,
  /\bimport\s*\(\s*["'`]([^"'`]+)["'`]/gu,
  /\brequire\s*\(\s*["'`]([^"'`]+)["'`]/gu,
];

/** Every module specifier a source text names. */
export function specifiersIn(text: string): string[] {
  return SPECIFIERS.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1] ?? ""));
}

/** Packages that are model clients: the model providers' SDKs and the AI frameworks around them. */
const MODEL_PACKAGES = [
  /^@anthropic-ai\//u,
  /^anthropic(?:$|\/)/u,
  /^openai(?:$|\/)/u,
  /^@openai\//u,
  /^@google\/(?:generative-ai|genai)(?:$|\/)/u,
  /^@ai-sdk\//u,
  /^ai(?:$|\/)/u,
  /^@mistralai\//u,
  /^cohere-ai(?:$|\/)/u,
  /^ollama(?:$|\/)/u,
  /^@langchain\//u,
  /^langchain(?:$|\/)/u,
  /^@aws-sdk\/client-bedrock/u,
];

/** True when a specifier imported by `fromFile` names a model client: a model SDK, or a module of the AI layer. */
export function namesModelClient(specifier: string, fromFile: string): boolean {
  if (MODEL_PACKAGES.some((pattern) => pattern.test(specifier))) return true;
  if (specifier === "@rosie/ai" || specifier.startsWith("@rosie/ai/")) return true;
  if (!specifier.startsWith(".")) return false;
  const relative = path.relative(ROOT, path.resolve(path.dirname(fromFile), specifier));
  return relative === "ai" || relative.startsWith(`ai${path.sep}`);
}

describe("no model client is imported anywhere under actions/src/frontier", () => {
  const files = codeFiles(FRONTIER_DIR);

  it("scans every file of the folder: its index, the assembler and the open-questions source, tests included", () => {
    const names = files.map((file) => path.relative(FRONTIER_DIR, file).split(path.sep).join("/"));
    for (const expected of [
      "index.ts",
      "assemble/assemble.ts",
      "assemble/handler.ts",
      "assemble/no-model-client.test.ts",
      "sources/open-questions/open-questions.ts",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("no file imports a model SDK or a module of the AI layer", () => {
    const found = files.flatMap((file) =>
      specifiersIn(readFileSync(file, "utf8"))
        .filter((specifier) => namesModelClient(specifier, file))
        .map((specifier) => `${path.relative(FRONTIER_DIR, file)}: ${specifier}`),
    );
    expect(found).toEqual([]);
  });

  it("the check is not vacuous: it finds every import form, and refuses a model SDK and the AI layer", () => {
    // The quotes are put in at run time, so this file's own text names none of these modules to the scan above.
    const q = '"';
    const sample = [
      `import Anthropic from ${q}@anthropic-ai/sdk${q};`,
      `export { decide } from ${q}../../../../ai/src/decide${q};`,
      `import ${q}openai/shims/node${q};`,
      `const gateway = await import(${q}../../../../ai/src/gateway/index.ts${q});`,
      `const { generateText } = require(${q}ai${q});`,
      `import { isLabel } from ${q}../../../../runtime/src/trace${q};`,
      `import Ajv2020 from ${q}ajv/dist/2020.js${q};`,
    ].join("\n");
    const from = path.join(FRONTIER_DIR, "assemble", "sample.ts");
    const specifiers = specifiersIn(sample);
    expect(specifiers).toHaveLength(7);
    expect(specifiers.filter((specifier) => namesModelClient(specifier, from))).toEqual([
      "@anthropic-ai/sdk",
      "../../../../ai/src/decide",
      "openai/shims/node",
      "../../../../ai/src/gateway/index.ts",
      "ai",
    ]);
    // The frontier's real imports pass: the runtime's trace, the Tool API, Ajv, the contracts' generated types.
    expect(namesModelClient("../../../../contracts/generated/model/model.v1", from)).toBe(false);
    expect(namesModelClient("../../tool-api/validator", from)).toBe(false);
  });
});
