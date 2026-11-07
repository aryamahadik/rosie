// The recorded-sample loader for adapter tests (T-410; 02-contracts section 5: "the vendor's wire format stays inside the
// adapter, with recorded vendor samples in the adapter's own tests"). A port's samples live in
// adapters/src/<port>/samples/, beside its adapter and double. This file is for tests: it reads files with node:fs, so
// the adapters' index does not export it and no Worker bundle takes it in.
//
// A sample is refused, whole, when it could hold real data (BP rules 7 and 9):
//   - a key-shaped value (a Stripe, Resend, Anthropic or Google key, or a bearer token);
//   - a phone number that is not a fictional one (the +1 xxx 555 01xx block that numbering plans reserve for fiction),
//     unless the caller lists it in `allow`;
//   - an email address outside the reserved example domains (example.com, .org, .net, .test, .invalid), unless listed.
// The error names the file and the kind of value, never the value.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findPrivateValue } from "./redact";
import type { PortFolder } from "./ports";

export class RecordedSampleError extends Error {
  override readonly name = "RecordedSampleError";
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(problems.join("\n"));
    this.problems = problems;
  }
}

export interface SampleOptions {
  /** Exact values a sample may hold although they look private, such as the Rosie line's own number. */
  readonly allow?: readonly string[];
}

const ADAPTERS_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The folder of a port's recorded samples: adapters/src/<port>/samples. */
export function samplesDir(port: PortFolder): string {
  return path.join(ADAPTERS_SRC, port, "samples");
}

const FICTIONAL_PHONE = /^\+1[2-9][0-9]{2}55501[0-9]{2}$/;
const EXAMPLE_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|[a-z0-9-]+\.(?:test|invalid)|test|invalid)$/i;

/** The problems a sample's text holds, one line each, by kind only. */
function privateProblems(file: string, text: string, allow: readonly string[]): string[] {
  const problems: string[] = [];
  const allowed = new Set(allow);
  if (findPrivateValue(text, { looseNumbers: false }) === "key")
    problems.push(`${file}: holds a key-shaped value`);
  for (const match of text.matchAll(/\+[1-9][0-9]{6,14}/g)) {
    if (!FICTIONAL_PHONE.test(match[0]) && !allowed.has(match[0]))
      problems.push(`${file}: holds a phone number that is not a fictional one (+1 xxx 555 01xx)`);
  }
  for (const match of text.matchAll(/[^@\s"'<>,;]+@([^@\s"'<>,;]+[.][^@\s"'<>,;]+)/g)) {
    if (!EXAMPLE_DOMAIN.test(match[1] ?? "") && !allowed.has(match[0]))
      problems.push(`${file}: holds an email address outside the reserved example domains`);
  }
  return [...new Set(problems)];
}

/** A path under `dir`, by a relative name that stays inside it. */
function resolveInside(dir: string, name: string): string {
  const absolute = path.resolve(dir, name);
  if (path.isAbsolute(name) || path.relative(dir, absolute).startsWith(".."))
    throw new RecordedSampleError([`${name}: is outside the samples folder`]);
  return absolute;
}

/** A sample's exact text, as recorded (a webhook's raw body must reach its signature check byte for byte). */
export function loadRecordedSampleText(dir: string, name: string, options: SampleOptions = {}): string {
  const absolute = resolveInside(dir, name);
  let text: string;
  try {
    text = readFileSync(absolute, "utf8");
  } catch {
    throw new RecordedSampleError([`${name}: cannot be read`]);
  }
  const problems = privateProblems(name, text, options.allow ?? []);
  if (problems.length > 0) throw new RecordedSampleError(problems);
  return text;
}

/** A JSON sample, parsed. */
export function loadRecordedSample(dir: string, name: string, options: SampleOptions = {}): unknown {
  const text = loadRecordedSampleText(dir, name, options);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RecordedSampleError([`${name}: is not valid JSON`]);
  }
}

/** The names of the samples in `dir` (every file, sorted); empty when the folder does not exist. */
export function listRecordedSamples(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
